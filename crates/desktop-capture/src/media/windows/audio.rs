//! WASAPI PCM stays on a native worker and is fed directly to WebRTC.
mod activation;
mod events;
use crate::media::{AudioCaptureFormat, AUDIO_CHANNEL_COUNTS, AUDIO_SAMPLE_RATES};
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
    Media::Audio::*,
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};

pub(super) struct Loopback {
    pub source: NativeAudioSource,
    events: Arc<events::Events>,
    enabled: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Loopback {
    pub fn start(
        rate: u32,
        channels: u32,
        changed: Arc<crate::lifecycle::Subscription>,
    ) -> Result<Self> {
        let source = NativeAudioSource::new(AudioSourceOptions::default(), rate, channels, 0);
        let events = Arc::new(events::Events::new()?);
        let enabled = Arc::new(AtomicBool::new(true));
        let worker_enabled = enabled.clone();
        let error = Arc::new(Mutex::new(None));
        let (ready, rx) = mpsc::sync_channel(1);
        let runtime = tokio::runtime::Handle::current();
        let worker_source = source.clone();
        let worker_events = events.clone();
        let worker_error = error.clone();
        let worker = thread::Builder::new()
            .name("screen-audio".into())
            .spawn(move || {
                let result = run(
                    &worker_source,
                    &worker_events,
                    &worker_enabled,
                    &runtime,
                    &ready,
                    rate,
                    channels,
                );
                if let Err(error) = result {
                    let _ = ready.try_send(Err(error.clone()));
                    if !worker_events.stopped() {
                        *worker_error.lock().unwrap_or_else(|e| e.into_inner()) = Some(error);
                        changed.notify();
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let capture = Self {
            source,
            events,
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
        self.events.stop();
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
struct Started(IAudioClient);
impl Drop for Started {
    fn drop(&mut self) {
        let _ = unsafe { self.0.Stop() };
    }
}

fn initialize(client: &IAudioClient, rate: u32, channels: u32) -> windows::core::Result<()> {
    let format = WAVEFORMATEX {
        wFormatTag: 1, // PCM signed 16-bit, resampled by the shared audio engine.
        nChannels: channels as u16,
        nSamplesPerSec: rate,
        nAvgBytesPerSec: rate * channels * 2,
        nBlockAlign: (channels * 2) as u16,
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
}

/// Process loopback has no reliable GetMixFormat/IsFormatSupported inventory.
/// Initialize a fresh client with the same conversion flags as real capture for
/// each candidate. Never Start, request a capture buffer, or read audio here.
pub(super) fn supported_formats() -> Result<Vec<AudioCaptureFormat>> {
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    let mut formats = Vec::new();
    for rate in AUDIO_SAMPLE_RATES {
        for channels in AUDIO_CHANNEL_COUNTS {
            let client = activation::excluding_current_process()?;
            match initialize(&client, rate, channels) {
                Ok(()) => formats.push(AudioCaptureFormat {
                    sample_rate: rate,
                    channel_count: channels,
                }),
                Err(error) if error.code() == AUDCLNT_E_UNSUPPORTED_FORMAT => {}
                Err(error) => return Err(format!("Could not query system audio formats: {error}")),
            }
        }
    }
    if formats.is_empty() {
        return Err("No supported system audio capture formats".into());
    }
    Ok(formats)
}

fn run(
    source: &NativeAudioSource,
    events: &events::Events,
    enabled: &AtomicBool,
    runtime: &tokio::runtime::Handle,
    ready: &mpsc::SyncSender<Result<()>>,
    rate: u32,
    channels: u32,
) -> Result<()> {
    let frame_samples = (rate / 100 * channels) as usize;
    unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
        .ok()
        .map_err(|e| e.to_string())?;
    let _apartment = Apartment;
    let client = activation::excluding_current_process()?;
    initialize(&client, rate, channels)
        .map_err(|e| format!("Could not initialize system audio: {e}"))?;
    unsafe { client.SetEventHandle(events.packet_handle()) }.map_err(|e| e.to_string())?;
    let capture: IAudioCaptureClient = unsafe { client.GetService() }.map_err(|e| e.to_string())?;
    unsafe { client.Start() }.map_err(|e| e.to_string())?;
    let _started = Started(client);
    ready.send(Ok(())).map_err(|e| e.to_string())?;
    let mut queue = VecDeque::with_capacity(frame_samples * 4);
    let mut samples = vec![0i16; frame_samples];
    while events.wait()? {
        while !events.stopped()
            && unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())? > 0
        {
            read_packet(&capture, &mut queue, rate, channels)?;
            // Bound latency after suspension or a stalled callback to 100 ms.
            if queue.len() > frame_samples * 10 {
                let excess = (queue.len() - frame_samples * 10) / frame_samples * frame_samples;
                queue.drain(..excess);
            }
            while queue.len() >= frame_samples && !events.stopped() {
                for sample in &mut samples {
                    *sample = queue.pop_front().unwrap();
                }
                if !enabled.load(Ordering::Acquire) {
                    samples.fill(0);
                }
                runtime
                    .block_on(source.capture_frame(&AudioFrame {
                        data: Cow::Borrowed(&samples),
                        sample_rate: rate,
                        num_channels: channels,
                        samples_per_channel: rate / 100,
                    }))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn read_packet(
    capture: &IAudioCaptureClient,
    queue: &mut VecDeque<i16>,
    rate: u32,
    channels: u32,
) -> Result<()> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0;
    let mut flags = 0;
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
        .map_err(|e| e.to_string())?;
    let result = (|| {
        if frames > rate {
            return Err("System audio packet exceeds one second".to_string());
        }
        if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
            queue.clear();
        }
        let count = frames as usize * channels as usize;
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
