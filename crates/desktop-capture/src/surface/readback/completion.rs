//! Wake the capture worker when the submitted GPU copy has finished.
use std::{
    ffi::c_void,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio::sync::Notify;
use windows::{
    core::{Interface, Result},
    Win32::{
        Foundation::{CloseHandle, HANDLE},
        Graphics::Direct3D11::{ID3D11DeviceContext, ID3D11DeviceContext3, D3D11_CONTEXT_TYPE_ALL},
        System::Threading::{
            CloseThreadpoolWait, CreateEventW, CreateThreadpoolWait, ResetEvent, SetThreadpoolWait,
            WaitForThreadpoolWaitCallbacks, PTP_CALLBACK_INSTANCE, PTP_WAIT,
        },
    },
};

pub(super) struct Completion {
    context: ID3D11DeviceContext3,
    event: HANDLE,
    wait: PTP_WAIT,
    // The allocation has a stable address until callbacks have been cancelled/joined.
    state: Box<State>,
}

struct State {
    notify: Arc<Notify>,
    ready: AtomicBool,
}

// The immediate context is multithread protected by Readback::copy_at. The handles
// may move between worker threads; only &mut self arms them. Callbacks only access
// State's atomic flag and Notify, and Drop joins them before freeing that allocation.
unsafe impl Send for Completion {}

impl Completion {
    pub(super) fn new(context: &ID3D11DeviceContext, notify: Arc<Notify>) -> Result<Self> {
        let context = context.cast()?;
        let event = unsafe { CreateEventW(None, false, false, None)? };
        let mut state = Box::new(State {
            notify,
            ready: AtomicBool::new(false),
        });
        let wait = unsafe {
            CreateThreadpoolWait(
                Some(completed),
                Some((&mut *state as *mut State).cast()),
                None,
            )
        };
        let wait = match wait {
            Ok(wait) => wait,
            Err(error) => {
                unsafe {
                    let _ = CloseHandle(event);
                }
                return Err(error);
            }
        };
        Ok(Self {
            context,
            event,
            wait,
            state,
        })
    }

    pub(super) fn ready(&self) -> bool {
        self.state.ready.load(Ordering::Acquire)
    }

    fn arm(&mut self) -> Result<()> {
        // Join the previous callback before clearing its flag. A source-frame
        // wakeup must not mistake that old notification for this submission.
        unsafe {
            SetThreadpoolWait(self.wait, None, None);
            WaitForThreadpoolWaitCallbacks(self.wait, true);
            self.state.ready.store(false, Ordering::Release);
            ResetEvent(self.event)?;
            SetThreadpoolWait(self.wait, Some(self.event), None);
        }
        Ok(())
    }

    pub(super) fn flush(&mut self) -> Result<()> {
        self.arm()?;
        unsafe {
            self.context
                .Flush1(D3D11_CONTEXT_TYPE_ALL, Some(self.event));
        }
        Ok(())
    }
}

impl Drop for Completion {
    fn drop(&mut self) {
        unsafe {
            SetThreadpoolWait(self.wait, None, None);
            WaitForThreadpoolWaitCallbacks(self.wait, true);
            CloseThreadpoolWait(self.wait);
            let _ = CloseHandle(self.event);
        }
    }
}

unsafe extern "system" fn completed(
    _: PTP_CALLBACK_INSTANCE,
    context: *mut c_void,
    _: PTP_WAIT,
    _: u32,
) {
    // Completion owns this allocation and joins the callback before freeing it.
    let state = unsafe { &*context.cast::<State>() };
    state.ready.store(true, Ordering::Release);
    state.notify.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use windows::Win32::System::Threading::SetEvent;

    #[test]
    fn notification_rearms_and_drop_cancels_outstanding_waits() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (_, context) = windows_capture::d3d11::create_d3d_device().unwrap();
            let notify = Arc::new(Notify::new());
            let mut completion = Completion::new(&context, notify.clone()).unwrap();
            for _ in 0..4 {
                completion.arm().unwrap();
                assert!(!completion.ready());
                unsafe {
                    SetEvent(completion.event).unwrap();
                }
                tokio::time::timeout(Duration::from_secs(2), notify.notified())
                    .await
                    .unwrap();
                assert!(completion.ready());
            }
            let weak = Arc::downgrade(&notify);
            completion.arm().unwrap();
            drop(notify);
            drop(completion);
            assert!(
                weak.upgrade().is_none(),
                "Callback retained the closed worker"
            );
        });
    }
}
