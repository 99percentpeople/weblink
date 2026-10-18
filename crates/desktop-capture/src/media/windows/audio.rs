//! WASAPI PCM stays on a native worker and is fed directly to WebRTC.
mod activation;
mod events;
use crate::media::recording::{clock_us, EncodedRecordingTap, Packet, PacketKind};
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
    pub recording: Arc<EncodedRecordingTap>,
    pub format: AudioCaptureFormat,
    events: Arc<events::Events>,
    enabled: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

impl Loopback {
    #[cfg(test)]
    pub fn synthetic(rate: u32, channels: u32) -> Result<Self> {
        Ok(Self {
            source: NativeAudioSource::new(AudioSourceOptions::default(), rate, channels, 0),
            recording: Arc::new(EncodedRecordingTap::default()),
            format: AudioCaptureFormat {
                sample_rate: rate,
                channel_count: channels,
            },
            events: Arc::new(events::Events::new()?),
            enabled: Arc::new(AtomicBool::new(true)),
            error: Arc::new(Mutex::new(None)),
            worker: Mutex::new(None),
        })
    }
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
        let worker_source = source.clone();
        let worker_events = events.clone();
        let worker_error = error.clone();
        let recording = Arc::new(EncodedRecordingTap::default());
        let tap = recording.clone();
        let worker = thread::Builder::new()
            .name("screen-audio".into())
            .spawn(move || {
                let result = run(
                    &worker_source,
                    &worker_events,
                    &worker_enabled,
                    &ready,
                    rate,
                    channels,
                    &tap,
                );
                tap.end();
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
            recording,
            format: AudioCaptureFormat {
                sample_rate: rate,
                channel_count: channels,
            },
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
        self.recording.end();
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
    ready: &mpsc::SyncSender<Result<()>>,
    rate: u32,
    channels: u32,
    recording: &EncodedRecordingTap,
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
    let mut queue_time = 0i64;
    let mut frequency = 0i64;
    let mut counter = 0i64;
    unsafe {
        windows::Win32::System::Performance::QueryPerformanceFrequency(&mut frequency)
            .map_err(|e| e.to_string())?;
        windows::Win32::System::Performance::QueryPerformanceCounter(&mut counter)
            .map_err(|e| e.to_string())?;
    }
    let qpc_offset = clock_us() - (counter as i128 * 1_000_000 / frequency as i128) as i64;
    while events.wait()? {
        while !events.stopped()
            && unsafe { capture.GetNextPacketSize() }.map_err(|e| e.to_string())? > 0
        {
            read_packet(
                &capture,
                &mut queue,
                rate,
                channels,
                &mut queue_time,
                qpc_offset,
            )?;
            // Bound latency after suspension or a stalled callback to 100 ms.
            if queue.len() > frame_samples * 10 {
                let excess = (queue.len() - frame_samples * 10) / frame_samples * frame_samples;
                queue.drain(..excess);
                queue_time += excess as i64 * 1_000_000 / channels as i64 / rate as i64;
            }
            while queue.len() >= frame_samples && !events.stopped() {
                for sample in &mut samples {
                    *sample = queue.pop_front().unwrap();
                }
                if !enabled.load(Ordering::Acquire) {
                    samples.fill(0);
                }
                deliver(
                    source,
                    recording,
                    &AudioFrame {
                        data: Cow::Borrowed(&samples),
                        sample_rate: rate,
                        num_channels: channels,
                        samples_per_channel: rate / 100,
                    },
                    queue_time,
                )?;
                queue_time += 10_000;
            }
        }
    }
    Ok(())
}

/// Deliver capture to the real sender first, then optionally copy PCM for fallback.
pub(super) fn deliver(
    source: &NativeAudioSource,
    recording: &EncodedRecordingTap,
    frame: &AudioFrame<'_>,
    timestamp_us: i64,
) -> Result<()> {
    source
        .capture_frame_at(frame, timestamp_us)
        .map_err(|e| e.to_string())?;
    if recording.has_subscriber() {
        recording.publish(Packet {
            bytes: frame
                .data
                .iter()
                .flat_map(|sample| sample.to_le_bytes())
                .collect(),
            timestamp_us,
            keyframe: true,
            kind: PacketKind::Audio {
                sample_rate: frame.sample_rate,
                channels: frame.num_channels,
            },
            segment: 0,
        });
    }
    Ok(())
}

fn read_packet(
    capture: &IAudioCaptureClient,
    queue: &mut VecDeque<i16>,
    rate: u32,
    channels: u32,
    queue_time: &mut i64,
    qpc_offset: i64,
) -> Result<()> {
    let mut data = std::ptr::null_mut();
    let mut frames = 0;
    let mut flags = 0;
    let mut qpc = 0u64;
    unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc)) }
        .map_err(|e| e.to_string())?;
    let result = (|| {
        if frames > rate {
            return Err("System audio packet exceeds one second".to_string());
        }
        if flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY.0 as u32 != 0 {
            queue.clear();
        }
        if queue.is_empty() {
            *queue_time = if qpc > 0 && flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 == 0 {
                qpc_offset + (qpc / 10) as i64
            } else {
                clock_us() - frames as i64 * 1_000_000 / rate as i64
            };
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
