//! WASAPI PCM stays on a native worker and is fed directly to WebRTC/Opus.
mod activation;
use crate::Result;
use libwebrtc::{
    audio_frame::AudioFrame,
    audio_source::{native::NativeAudioSource, AudioSourceOptions},
};
use std::{
    borrow::Cow,
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
    Media::Audio::*,
    System::{
        Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        Threading::{CreateEventW, WaitForSingleObject},
    },
};

const RATE: u32 = 48_000;
const CHANNELS: u32 = 2;
const SAMPLES: usize = (RATE / 100 * CHANNELS) as usize;

pub(super) struct Loopback {
    pub source: NativeAudioSource,
    stop: Arc<AtomicBool>,
    enabled: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Loopback {
    pub fn start() -> Result<Self> {
        let source = NativeAudioSource::new(AudioSourceOptions::default(), RATE, CHANNELS, 0);
        let stop = Arc::new(AtomicBool::new(false));
        let enabled = Arc::new(AtomicBool::new(true));
        let worker_enabled = enabled.clone();
        let error = Arc::new(Mutex::new(None));
        let (ready, rx) = mpsc::sync_channel(1);
        let runtime = tokio::runtime::Handle::current();
        let worker_source = source.clone();
        let worker_stop = stop.clone();
        let worker_error = error.clone();
        let worker = thread::Builder::new()
            .name("screen-audio".into())
            .spawn(move || {
                let result = run(
                    &worker_source,
                    &worker_stop,
                    &worker_enabled,
                    &runtime,
                    &ready,
                );
                if let Err(error) = result {
                    let _ = ready.try_send(Err(error.clone()));
                    if !worker_stop.load(Ordering::Acquire) {
                        *worker_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let capture = Self {
            source,
            stop,
            enabled,
            error,
            worker: Mutex::new(Some(worker)),
        };
        rx.recv_timeout(Duration::from_secs(8))
            .map_err(|_| "System audio startup timed out".to_string())??;
        Ok(capture)
    }
    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn close(&self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            let _ = worker.join();
        }
        self.source.clear_buffer();
    }
}
impl Drop for Loopback {
    fn drop(&mut self) {
        self.close();
    }
}
struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}
struct Event(HANDLE);
impl Drop for Event {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}
struct Started(IAudioClient);
impl Drop for Started {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Stop() };
    }
}

fn run(
    source: &NativeAudioSource,
    stop: &AtomicBool,
    enabled: &AtomicBool,
    runtime: &tokio::runtime::Handle,
    ready: &mpsc::SyncSender<Result<()>>,
) -> Result<()> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    let client = activation::excluding_current_process()?;
    let format = WAVEFORMATEX {
        wFormatTag: 1, // PCM signed 16-bit, resampled by the shared audio engine.
        nChannels: CHANNELS as u16,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * CHANNELS * 2,
        nBlockAlign: (CHANNELS * 2) as u16,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            200_000,
            0,
            &format,
            None,
        )
    }
    .map_err(|e| format!("Could not initialize system audio: {e}"))?;
    let event =
        Event(unsafe { CreateEventW(None, false, false, None) }.map_err(|e| e.to_string())?);
    unsafe { client.SetEventHandle(event.0) }.map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
    unsafe { client.Start() }.map_err(|e| e.to_string())?;
    let _started = Started(client);
    ready.send(Ok(())).map_err(|e| e.to_string())?;
    let mut queue = VecDeque::with_capacity(SAMPLES * 4);
    let mut samples = [0i16; SAMPLES];
    while !stop.load(Ordering::Acquire) {
        match unsafe { WaitForSingleObject(event.0, 50) } {
            WAIT_TIMEOUT => continue,
            WAIT_OBJECT_0 => {}
            _ => return Err("System audio event failed".into()),
        }
        while !stop.load(Ordering::Acquire)
            && unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())? > 0
        {
            read_packet(&capture, &mut queue)?;
            // Bound latency after suspension or a stalled callback to 100 ms.
            if queue.len() > SAMPLES * 10 {
                let excess = (queue.len() - SAMPLES * 10) / SAMPLES * SAMPLES;
                queue.drain(..excess);
            }
            while queue.len() >= SAMPLES && !stop.load(Ordering::Acquire) {
                for sample in &mut samples {
                    *sample = queue.pop_front().unwrap();
                }
                if !enabled.load(Ordering::Acquire) {
                    samples.fill(0);
                }
                runtime
                    .block_on(source.capture_frame(&AudioFrame {
                        data: Cow::Borrowed(&samples),
                        sample_rate: RATE,
                        num_channels: CHANNELS,
                        samples_per_channel: RATE / 100,
                    }))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn read_packet(capture: &IAudioCaptureClient, queue: &mut VecDeque<i16>) -> Result<()> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0;
    let mut flags = 0;
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
        .map_err(|e| e.to_string())?;
    let result = (|| {
        if frames > RATE {
            return Err("System audio packet exceeds one second".to_string());
        }
        if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
            queue.clear();
        }
        let count = frames as usize * CHANNELS as usize;
        // Silent WASAPI buffers may be null. Never dereference them.
        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
            queue.extend(std::iter::repeat_n(0, count));
        } else if count > 0 {
            if data.is_null() {
                return Err("Missing system audio buffer".into());
            }
            let bytes = unsafe { std::slice::from_raw_parts(data, count * 2) };
            queue.extend(
                bytes
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|b| i16::from_le_bytes([b[0], b[1]])),
            );
        }
        Ok(())
    })();
    let released = unsafe { capture.ReleaseBuffer(frames) }.map_err(|e| e.to_string());
    result.and(released)
}
