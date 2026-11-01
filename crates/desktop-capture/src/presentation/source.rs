//! Immutable native images, bounded latest-frame ownership and opt-in readback.
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, Weak,
    },
    time::Instant,
};
use windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;
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
struct Watcher {
    wake: Wake,
    demand: bool,
    frames: bool,
}
#[derive(Default)]
struct SourceState {
    latest: Option<Arc<Frame>>,
    watchers: HashMap<u64, Watcher>,
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
    pub(super) readback: Mutex<Weak<super::recording::Pool>>,
}
pub struct Subscription {
    source: Weak<Source>,
    id: u64,
}
impl Subscription {
    pub fn set_active(&self, active: bool) {
        if let Some(source) = self.source.upgrade() {
            if let Some(watcher) = source.state.lock().unwrap().watchers.get_mut(&self.id) {
                watcher.demand = active;
            }
        }
    }
    /// Frame interest is independent of capture demand. Hidden consumers still
    /// receive close/error; resuming refreshes retained dimensions/static frames.
    pub fn set_frames(&self, enabled: bool) {
        if let Some(source) = self.source.upgrade() {
            let wake = {
                let mut state = source.state.lock().unwrap();
                state.watchers.get_mut(&self.id).and_then(|watcher| {
                    let changed = watcher.frames != enabled;
                    watcher.frames = enabled;
                    (changed && enabled).then(|| watcher.wake.clone())
                })
            };
            if let Some(wake) = wake {
                wake();
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
            // Even a view bound while dimensions are still unknown needs the
            // first frame's metadata to bootstrap its placeholder/layout. After
            // that, hidden observers only wake on restore, close or error.
            let first = state.latest.is_none();
            state.latest = Some(Arc::new(Frame {
                sequence: self.sequence.fetch_add(1, Ordering::Relaxed) + 1,
                texture,
                ready: Instant::now(),
            }));
            state
                .watchers
                .values()
                .filter(|watcher| first || watcher.frames)
                .map(|watcher| watcher.wake.clone())
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
        !state.closed && state.watchers.values().any(|watcher| watcher.demand)
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
                .map(|watcher| watcher.wake.clone())
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
        self.state.lock().unwrap().watchers.insert(
            id,
            Watcher {
                wake: wake.clone(),
                demand: active,
                frames: true,
            },
        );
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
            .map(|watcher| watcher.wake.clone())
            .collect::<Vec<_>>();
        for callback in callbacks {
            callback();
        }
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
