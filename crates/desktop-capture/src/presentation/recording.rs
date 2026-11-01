//! Opt-in recording readback. Idle slots are shared by consumers of one source;
//! presentation itself never allocates staging textures or waits for CPU pixels.
use super::{Frame, Source, Subscription};
use crate::surface::readback::completion::Completion;
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};
use windows::{
    core::Interface,
    Win32::Graphics::{
        Direct3D11::{
            ID3D11Device, ID3D11DeviceContext, ID3D11Multithread, ID3D11Texture2D,
            D3D11_CPU_ACCESS_READ, D3D11_MAPPED_SUBRESOURCE, D3D11_MAP_FLAG_DO_NOT_WAIT,
            D3D11_MAP_READ, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING,
        },
        Dxgi::{Common::DXGI_FORMAT_NV12, DXGI_ERROR_WAS_STILL_DRAWING},
    },
};

const TIMEOUT: Duration = Duration::from_secs(2);
// Return occasionally so a static recording can refresh its retained VideoFrame.
// New frames and cancellation wake immediately; there is no empty-frame polling.
const REFRESH: Duration = Duration::from_millis(500);
// Independent of the sender's readbackBuffers setting. A consumer has one read
// in flight; two consumers may overlap work without an unbounded GPU queue.
const SLOTS: usize = 2;

pub struct Recording {
    source: Arc<Source>,
    state: Mutex<Option<(Arc<Pool>, Subscription)>>,
    reading: Arc<Semaphore>,
    changed: Arc<Notify>,
}

impl Source {
    pub fn recording(self: &Arc<Self>) -> Recording {
        let mut weak = self.readback.lock().unwrap();
        let pool = weak.upgrade().unwrap_or_else(|| Arc::new(Pool::default()));
        *weak = Arc::downgrade(&pool);
        let changed = Arc::new(Notify::new());
        let wake = changed.clone();
        Recording {
            source: self.clone(),
            state: Mutex::new(Some((
                pool,
                self.subscribe(Arc::new(move || wake.notify_one())),
            ))),
            reading: Arc::new(Semaphore::new(1)),
            changed,
        }
    }
}

impl Recording {
    pub fn close(&self) {
        // In-flight copies own their pool and complete frame lease until the GPU
        // signals completion. Idle buffers disappear when the last reader closes.
        self.state.lock().unwrap().take();
        self.changed.notify_one();
    }

    async fn next_frame(&self, after: u64) -> Result<Option<Arc<Frame>>, String> {
        let deadline = tokio::time::Instant::now() + REFRESH;
        loop {
            // Register before reading state: publication/close between the check
            // and await must not be lost, including the first frame of a source.
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.state.lock().unwrap().is_none() {
                return Err("Native recording closed".into());
            }
            if self.source.closed() {
                return Err("Native video source ended".into());
            }
            if let Some(error) = self.source.stats().error {
                return Err(error);
            }
            if let Some(frame) = self.source.latest().filter(|f| f.sequence > after) {
                return Ok(Some(frame));
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return Ok(None);
            }
        }
    }

    pub async fn read_frame(&self, after: u64) -> Result<Vec<u8>, String> {
        let reading = self
            .reading
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Native frame read already in progress")?;
        let pool = self
            .state
            .lock()
            .unwrap()
            .as_ref()
            .map(|(pool, _)| pool.clone())
            .ok_or("Native recording closed")?;
        let Some(frame) = self.next_frame(after).await? else {
            return Ok(Vec::new());
        };
        let permit = pool
            .capacity
            .clone()
            .try_acquire_owned()
            .map_err(|_| "Native recording readback pool busy")?;
        // Detach cancellation from GPU ownership. Closing the page, stopping a
        // recording or timing out must not return an MF sample to its decoder
        // while the GPU still reads it. No blocking thread waits for the GPU.
        let task = tokio::spawn(async move {
            let (_reading, _permit) = (reading, permit);
            pool.read(frame).await
        });
        let data = tokio::time::timeout(TIMEOUT, task)
            .await
            .map_err(|_| "Native recording readback timed out")?
            .map_err(|e| e.to_string())??;
        if self.state.lock().unwrap().is_none() || self.source.closed() {
            return Err("Native recording closed".into());
        }
        Ok(data)
    }
}

pub(super) struct Pool {
    idle: Mutex<Vec<Slot>>,
    capacity: Arc<Semaphore>,
}
impl Default for Pool {
    fn default() -> Self {
        Self {
            idle: Mutex::new(Vec::new()),
            capacity: Arc::new(Semaphore::new(SLOTS)),
        }
    }
}
impl Pool {
    async fn read(self: Arc<Self>, frame: Arc<Frame>) -> Result<Vec<u8>, String> {
        let pool = self.clone();
        let (slot, frame) = tokio::task::spawn_blocking(move || {
            let (device, desc) = describe(&frame)?;
            let mut slot = {
                let mut idle = pool.idle.lock().unwrap();
                idle.retain(|s| s.matches(&device, &desc));
                idle.pop()
            }
            .map(Ok)
            .unwrap_or_else(|| Slot::new(device, &desc))?;
            slot.submit(&frame)?;
            Ok::<_, String>((slot, frame))
        })
        .await
        .map_err(|e| e.to_string())??;
        self.finish(slot, frame).await
    }

    async fn finish(&self, mut slot: Slot, mut frame: Arc<Frame>) -> Result<Vec<u8>, String> {
        loop {
            while !slot.completion.ready() {
                // This is a device-removal watchdog, not a Map polling timer.
                // If a healthy driver stalls, retain at most SLOTS frame leases
                // until completion rather than returning them to the decoder.
                if tokio::time::timeout(TIMEOUT, slot.notify.notified())
                    .await
                    .is_err()
                {
                    unsafe { slot.device.GetDeviceRemovedReason() }.map_err(|e| e.to_string())?;
                }
            }
            let (returned, held, data) = tokio::task::spawn_blocking(move || {
                let data = slot.read(&frame);
                (slot, frame, data)
            })
            .await
            .map_err(|e| e.to_string())?;
            slot = returned;
            frame = held;
            if let Some(data) = data? {
                self.idle.lock().unwrap().push(slot);
                return Ok(data);
            }
        }
    }
}

fn describe(frame: &Frame) -> Result<(ID3D11Device, D3D11_TEXTURE2D_DESC), String> {
    let t = &frame.texture;
    let (w, h) = t.size;
    let (x, y) = t.crop;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    unsafe { t.texture.GetDesc(&mut desc) };
    if w < 2
        || h < 2
        || w > 3840
        || h > 2160
        || w % 2 != 0
        || h % 2 != 0
        || x % 2 != 0
        || y % 2 != 0
        || desc.Format != DXGI_FORMAT_NV12
        || desc.MipLevels != 1
        || desc.SampleDesc.Count != 1
        || desc.Width > 16384
        || desc.Height > 16384
        || t.subresource >= desc.ArraySize
        || x.checked_add(w).is_none_or(|v| v > desc.Width)
        || y.checked_add(h).is_none_or(|v| v > desc.Height)
    {
        return Err("Invalid native readback texture or crop".into());
    }
    let device = unsafe { t.texture.GetDevice() }.map_err(|e| e.to_string())?;
    Ok((device, desc))
}

struct Slot {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    staging: ID3D11Texture2D,
    size: (u32, u32),
    completion: Completion,
    notify: Arc<Notify>,
}
impl Slot {
    fn matches(&self, device: &ID3D11Device, desc: &D3D11_TEXTURE2D_DESC) -> bool {
        self.device == *device && self.size == (desc.Width, desc.Height)
    }
    fn new(device: ID3D11Device, desc: &D3D11_TEXTURE2D_DESC) -> Result<Self, String> {
        let context = unsafe { device.GetImmediateContext() }.map_err(|e| e.to_string())?;
        let protection: ID3D11Multithread = context.cast().map_err(|e| e.to_string())?;
        unsafe {
            let _ = protection.SetMultithreadProtected(true);
            if !protection.GetMultithreadProtected().as_bool() {
                return Err("Recording requires a thread-safe D3D context".into());
            }
        }
        let mut desc = *desc;
        desc.ArraySize = 1;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.MiscFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }
            .map_err(|e| e.to_string())?;
        let notify = Arc::new(Notify::new());
        let completion = Completion::new(&context, notify.clone()).map_err(|e| e.to_string())?;
        Ok(Self {
            device,
            context,
            staging: staging.ok_or("Missing recording staging texture")?,
            size: (desc.Width, desc.Height),
            completion,
            notify,
        })
    }
    fn submit(&mut self, frame: &Frame) -> Result<(), String> {
        self.completion
            .submit(|| unsafe {
                self.context.CopySubresourceRegion(
                    &self.staging,
                    0,
                    0,
                    0,
                    0,
                    &frame.texture.texture,
                    frame.texture.subresource,
                    None,
                );
            })
            .map_err(|e| e.to_string())
    }
    fn read(&mut self, frame: &Frame) -> Result<Option<Vec<u8>>, String> {
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        match unsafe {
            self.context.Map(
                &self.staging,
                0,
                D3D11_MAP_READ,
                D3D11_MAP_FLAG_DO_NOT_WAIT.0 as u32,
                Some(&mut mapped),
            )
        } {
            Ok(()) => {}
            Err(e) if e.code() == DXGI_ERROR_WAS_STILL_DRAWING => {
                self.completion.flush().map_err(|e| e.to_string())?;
                return Ok(None);
            }
            Err(e) => return Err(e.to_string()),
        }
        // All exits unmap, including a driver returning an invalid row pitch.
        let guard = Mapped { slot: self };
        if mapped.pData.is_null() || mapped.RowPitch < self.size.0 {
            return Err("Invalid native recording row pitch".into());
        }
        let t = &frame.texture;
        let (w, h) = (t.size.0 as usize, t.size.1 as usize);
        let pitch = mapped.RowPitch as usize;
        let (x, y) = (t.crop.0 as usize, t.crop.1 as usize);
        // The IPC response must own its bytes; only staging/event resources are
        // pooled. Pack directly into that response, without an intermediate Vec.
        let mut data = vec![0; 24 + w * h * 3 / 2];
        data[..4].copy_from_slice(&t.size.0.to_le_bytes());
        data[4..8].copy_from_slice(&t.size.1.to_le_bytes());
        data[8..16].copy_from_slice(&frame.sequence.to_le_bytes());
        data[16] = t.bt709 as u8;
        data[17] = t.full_range as u8;
        for row in 0..h + h / 2 {
            let source_row = if row < h {
                y + row
            } else {
                self.size.1 as usize + y / 2 + row - h
            };
            let pixels = unsafe {
                std::slice::from_raw_parts(mapped.pData.cast::<u8>().add(source_row * pitch + x), w)
            };
            data[24 + row * w..24 + (row + 1) * w].copy_from_slice(pixels);
        }
        drop(guard);
        Ok(Some(data))
    }
}
struct Mapped<'a> {
    slot: &'a Slot,
}
impl Drop for Mapped<'_> {
    fn drop(&mut self) {
        unsafe {
            self.slot.context.Unmap(&self.slot.staging, 0);
        }
    }
}

#[cfg(test)]
mod tests;
