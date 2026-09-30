//! MFT callbacks only signal work. ProcessInput/Output stay on the encoder thread.
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, Weak,
    },
};
use windows::{
    core::{implement, AgileReference, IUnknown, IUnknownImpl, Ref, Result},
    Win32::{
        Foundation::{E_FAIL, E_NOTIMPL},
        Media::MediaFoundation::*,
    },
};

struct State {
    generator: AgileReference<IMFMediaEventGenerator>,
    queue: Mutex<VecDeque<Result<MF_EVENT_TYPE>>>,
    stopped: AtomicBool,
    wake: Arc<dyn Fn() + Send + Sync>,
}
pub(super) struct Events(Arc<State>);
impl Events {
    pub fn start(
        generator: IMFMediaEventGenerator,
        wake: Arc<dyn Fn() + Send + Sync>,
    ) -> Result<Self> {
        let state = Arc::new(State {
            generator: AgileReference::new(&generator)?,
            queue: Mutex::new(VecDeque::new()),
            stopped: AtomicBool::new(false),
            wake,
        });
        // The generator owns the callback; the callback borrows this state weakly.
        // Closing/reconfiguring a transform cannot keep its encoder alive.
        let callback: IMFAsyncCallback = Callback {
            state: Arc::downgrade(&state),
        }
        .into();
        unsafe {
            generator.BeginGetEvent(&callback, None::<&IUnknown>)?;
        }
        Ok(Self(state))
    }
    pub fn take(&self) -> VecDeque<Result<MF_EVENT_TYPE>> {
        std::mem::take(&mut *self.0.queue.lock().unwrap_or_else(|e| e.into_inner()))
    }
    pub fn stop(&self) {
        self.0.stopped.store(true, Ordering::Release);
    }
}
impl Drop for Events {
    fn drop(&mut self) {
        self.stop();
    }
}

#[implement(IMFAsyncCallback)]
struct Callback {
    state: Weak<State>,
}
impl IMFAsyncCallback_Impl for Callback_Impl {
    fn GetParameters(&self, _: *mut u32, _: *mut u32) -> Result<()> {
        Err(E_NOTIMPL.into())
    }
    fn Invoke(&self, result: Ref<IMFAsyncResult>) -> Result<()> {
        let Some(state) = self.state.upgrade() else {
            return Ok(());
        };
        if state.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        // Resolve in the callback's COM context; raw interface pointers are not
        // assumed Send/Sync across the encoder and MF worker threads.
        let generator = match state.generator.resolve() {
            Ok(generator) => generator,
            Err(error) => {
                state
                    .queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push_back(Err(error));
                (state.wake)();
                return Ok(());
            }
        };
        let event = unsafe {
            generator.EndGetEvent(result.as_ref()).and_then(|event| {
                event.GetStatus()?.ok()?;
                Ok(MF_EVENT_TYPE(event.GetType()? as i32))
            })
        };
        let failed = event.is_err();
        {
            let mut queue = state.queue.lock().unwrap_or_else(|e| e.into_inner());
            if queue.len() >= 256 {
                queue.clear();
                queue.push_back(Err(windows::core::Error::new(
                    E_FAIL,
                    "Hardware encoder event overflow",
                )));
                state.stopped.store(true, Ordering::Release);
            } else {
                queue.push_back(event);
            }
        }
        (state.wake)();
        if !failed && !state.stopped.load(Ordering::Acquire) {
            let callback: IMFAsyncCallback = self.to_interface();
            if let Err(error) = unsafe { generator.BeginGetEvent(&callback, None::<&IUnknown>) } {
                state
                    .queue
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push_back(Err(error));
                (state.wake)();
            }
        }
        Ok(())
    }
}
