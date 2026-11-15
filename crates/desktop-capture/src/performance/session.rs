//! Remote publication leases and scoped worker scheduling.
use super::{
    leases::{Lease, Registry},
    platform, Setting, Snapshot, Status, ThreadReport, ThreadRole,
};
use std::{
    marker::PhantomData,
    rc::Rc,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

#[cfg(test)]
mod tests;

#[derive(Default)]
pub struct Manager {
    timers: Arc<Registry<(), Setting<platform::Timer>>>,
    #[cfg(windows)]
    devices: Arc<Registry<usize, Setting<platform::Gpu>>>,
}
impl Manager {
    pub fn session(self: &Arc<Self>) -> Arc<Session> {
        Arc::new(Session {
            manager: self.clone(),
            state: Mutex::default(),
            active: AtomicBool::new(false),
            threads: Mutex::default(),
        })
    }
}

#[derive(Default)]
struct State {
    closed: bool,
    users: usize,
    timer: Option<Lease<(), Setting<platform::Timer>>>,
    #[cfg(windows)]
    device: Option<windows::Win32::Graphics::Direct3D11::ID3D11Device>,
    #[cfg(windows)]
    gpu: Option<Lease<usize, Setting<platform::Gpu>>>,
    #[cfg(windows)]
    gpu_error: Option<String>,
}

#[derive(Default)]
pub struct Session {
    manager: Arc<Manager>,
    state: Mutex<State>,
    active: AtomicBool,
    threads: Mutex<[Option<ThreadReport>; 2]>,
}
impl Session {
    /// Acquire only for a remote sender, not a local preview or encoder probe.
    pub fn acquire(self: &Arc<Self>) -> Option<StreamLease> {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return None;
        }
        if state.users == 0 {
            *self.threads.lock().unwrap_or_else(|e| e.into_inner()) = Default::default();
            state.timer = Some(self.manager.timers.acquire((), platform::timer));
            #[cfg(windows)]
            self.acquire_gpu(&mut state);
            self.active.store(true, Ordering::Release);
        }
        state.users += 1;
        Some(StreamLease(self.clone()))
    }
    fn release(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed {
            return;
        }
        state.users -= 1;
        if state.users == 0 {
            self.deactivate(&mut state);
        }
    }
    fn deactivate(&self, state: &mut State) {
        self.active.store(false, Ordering::Release);
        #[cfg(windows)]
        {
            state.gpu.take();
            state.gpu_error = None;
        }
        state.timer.take();
    }
    pub fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.users = 0;
        self.deactivate(&mut state);
        #[cfg(windows)]
        {
            state.device = None;
        }
    }
    /// Run synchronous work with a scoped hint, restoring the worker before return
    /// or unwind. Do not return a future here: only the closure itself is scoped.
    pub fn with_thread<T>(&self, role: ThreadRole, work: impl FnOnce() -> T) -> T {
        let _guard = self.enter_thread(role);
        work()
    }
    /// Internal escape hatch for the encoder loop's early waits. Guards are !Send
    /// and must drop in reverse acquisition order, never across an async suspension.
    pub(crate) fn enter_thread(&self, role: ThreadRole) -> Option<ThreadGuard> {
        if !self.active.load(Ordering::Acquire) {
            return None;
        }
        let native = platform::Thread::enter(role);
        let index = match role {
            ThreadRole::Capture => 0,
            ThreadRole::Encode => 1,
        };
        self.threads.lock().unwrap_or_else(|e| e.into_inner())[index] = Some(native.report());
        Some(ThreadGuard {
            _native: native,
            _thread: PhantomData,
        })
    }
    #[cfg(windows)]
    fn acquire_gpu(&self, state: &mut State) {
        let Some(device) = &state.device else { return };
        match platform::device_key(device) {
            Ok(key) => {
                state.gpu = Some(self.manager.devices.acquire(key, || platform::gpu(device)));
                state.gpu_error = None;
            }
            Err(error) => state.gpu_error = Some(error),
        }
    }
    /// Remember capture/encoder device replacement even while only previewing.
    #[cfg(windows)]
    pub fn set_gpu_device(&self, device: &windows::Win32::Graphics::Direct3D11::ID3D11Device) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.closed || state.device.as_ref() == Some(device) {
            return;
        }
        state.gpu.take();
        state.device = Some(device.clone());
        if state.users > 0 {
            self.acquire_gpu(&mut state);
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let threads = self.threads.lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(windows)]
        let gpu_scheduling = state
            .gpu
            .as_ref()
            .map(|lease| lease.inspect(|s| s.status.clone()))
            .unwrap_or_else(|| {
                state
                    .gpu_error
                    .clone()
                    .map(Status::Failed)
                    .unwrap_or(Status::Inactive)
            });
        #[cfg(not(windows))]
        let gpu_scheduling = Status::Unsupported;
        Snapshot {
            remote_consumers: state.users,
            timing: state
                .timer
                .as_ref()
                .map(|lease| lease.inspect(|s| s.status.clone()))
                .unwrap_or(Status::Inactive),
            gpu_scheduling,
            capture_thread: (state.users > 0).then(|| threads[0].clone()).flatten(),
            encode_thread: (state.users > 0).then(|| threads[1].clone()).flatten(),
        }
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

pub struct StreamLease(Arc<Session>);
impl Drop for StreamLease {
    fn drop(&mut self) {
        self.0.release();
    }
}

pub(crate) struct ThreadGuard {
    _native: platform::Thread,
    _thread: PhantomData<Rc<()>>,
}
