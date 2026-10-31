//! Immutable native images, bounded latest-frame ownership and opt-in readback.
use serde::Serialize;
use std::{
    collections::HashMap,
    ffi::c_void,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Instant,
};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
use windows_core::Interface;
unsafe extern "C" {
    fn wl_read_nv12(
        texture: *mut c_void,
        subresource: u32,
        crop_x: u32,
        crop_y: u32,
        width: u32,
        height: u32,
        output: *mut u8,
    ) -> i32;
}
#[derive(Clone)]
pub struct Texture {
    pub cpu_upload: bool,
    pub texture: ID3D11Texture2D,
    pub subresource: u32,
    pub crop: (u32, u32),
    pub size: (u32, u32),
    pub bt709: bool,
    pub full_range: bool,
    /// Holds the MF sample or capture pool lease, not just the texture COM ref.
    pub owner: Arc<dyn Send + Sync>,
}
pub struct Frame {
    pub sequence: u64,
    pub texture: Texture,
    pub(super) ready: Instant,
}
type Wake = Arc<dyn Fn() + Send + Sync>;
#[derive(Default)]
struct SourceState {
    latest: Option<Arc<Frame>>,
    watchers: HashMap<u64, (Wake, bool)>,
    closed: bool,
}
#[derive(Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    pub uploaded_frames: u64,
    pub presented_frames: u64,
    pub decoded_queue_ms: f64,
    pub submit_ms: f64,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct Source {
    state: Mutex<SourceState>,
    next: AtomicU64,
    sequence: AtomicU64,
    stats: Mutex<Stats>,
    readback: Mutex<()>,
}
pub struct Subscription {
    source: Weak<Source>,
    id: u64,
}
impl Subscription {
    pub fn set_active(&self, active: bool) {
        if let Some(source) = self.source.upgrade() {
            if let Some((_, demand)) = source.state.lock().unwrap().watchers.get_mut(&self.id) {
                *demand = active;
            }
        }
    }
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(source) = self.source.upgrade() {
            source.state.lock().unwrap().watchers.remove(&self.id);
        }
    }
}
impl Source {
    pub fn publish(&self, texture: Texture) {
        if texture.cpu_upload {
            self.stats.lock().unwrap().uploaded_frames += 1;
        }
        let callbacks = {
            let mut state = self.state.lock().unwrap();
            if state.closed {
                return;
            }
            state.latest = Some(Arc::new(Frame {
                sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
                texture,
                ready: Instant::now(),
            }));
            state
                .watchers
                .values()
                .map(|(wake, _)| wake.clone())
                .collect::<Vec<_>>()
        };
        for callback in callbacks {
            callback();
        }
    }
    pub fn latest(&self) -> Option<Arc<Frame>> {
        self.state.lock().unwrap().latest.clone()
    }
    pub fn active(&self) -> bool {
        let state = self.state.lock().unwrap();
        !state.closed && state.watchers.values().any(|(_, active)| *active)
    }
    pub fn closed(&self) -> bool {
        self.state.lock().unwrap().closed
    }
    pub fn close(&self) {
        let callbacks = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            state.latest = None;
            state
                .watchers
                .values()
                .map(|(wake, _)| wake.clone())
                .collect::<Vec<_>>()
        };
        for callback in callbacks {
            callback();
        }
    }
    pub fn subscribe(self: &Arc<Self>, wake: Wake) -> Subscription {
        self.observe(wake, true)
    }
    pub(super) fn observe(self: &Arc<Self>, wake: Wake, active: bool) -> Subscription {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        self.state
            .lock()
            .unwrap()
            .watchers
            .insert(id, (wake.clone(), active));
        wake();
        Subscription {
            source: Arc::downgrade(self),
            id,
        }
    }
    pub fn fail(&self, error: String) {
        self.stats.lock().unwrap().error = Some(error);
        let callbacks = self
            .state
            .lock()
            .unwrap()
            .watchers
            .values()
            .map(|(wake, _)| wake.clone())
            .collect::<Vec<_>>();
        for callback in callbacks {
            callback();
        }
    }
    /// Optional CPU pixels for recording; never used to feed the native surface.
    pub fn read_frame(&self, after: u64) -> Result<Vec<u8>, String> {
        let _reader = self
            .readback
            .try_lock()
            .map_err(|_| "Native frame read already in progress")?;
        let Some(frame) = self.latest().filter(|f| f.sequence > after) else {
            return Ok(Vec::new());
        };
        let t = &frame.texture;
        let (width, height) = t.size;
        if width < 2
            || height < 2
            || width > 3840
            || height > 2160
            || width % 2 != 0
            || height % 2 != 0
        {
            return Err("Invalid native readback size".into());
        }
        let mut data = vec![0; 24 + (width as usize * height as usize * 3 / 2)];
        data[..4].copy_from_slice(&width.to_le_bytes());
        data[4..8].copy_from_slice(&height.to_le_bytes());
        data[8..16].copy_from_slice(&frame.sequence.to_le_bytes());
        data[16] = t.bt709 as u8;
        data[17] = t.full_range as u8;
        let hr = unsafe {
            wl_read_nv12(
                t.texture.as_raw(),
                t.subresource,
                t.crop.0,
                t.crop.1,
                width,
                height,
                data[24..].as_mut_ptr(),
            )
        };
        if hr < 0 {
            return Err(format!("Native recording readback failed: {hr:#x}"));
        }
        Ok(data)
    }
    pub(super) fn presented(&self, queue_ms: f64, submit_ms: f64) {
        let mut stats = self.stats.lock().unwrap();
        stats.presented_frames += 1;
        stats.decoded_queue_ms = queue_ms;
        stats.submit_ms = submit_ms;
    }
    pub fn stats(&self) -> Stats {
        self.stats.lock().unwrap().clone()
    }
}
