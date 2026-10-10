//! Observe a library-owned capture thread without a periodic is_finished query.
use crate::{Frames, Result};
use std::{
    ffi::c_void,
    os::windows::io::{AsHandle, AsRawHandle, OwnedHandle},
    sync::{Arc, Mutex},
    thread::JoinHandle,
};
use windows::Win32::{
    Foundation::HANDLE,
    System::Threading::{
        CloseThreadpoolWait, CreateThreadpoolWait, SetThreadpoolWait,
        WaitForThreadpoolWaitCallbacks, PTP_CALLBACK_INSTANCE, PTP_WAIT,
    },
};

pub(super) struct ThreadExit {
    wait: PTP_WAIT,
    // Own a duplicate so cancellation is safe even if the original thread was joined.
    _thread: OwnedHandle,
    _frames: Box<Arc<Mutex<Frames>>>,
}
impl ThreadExit {
    pub fn new<T>(thread: &JoinHandle<T>, frames: Arc<Mutex<Frames>>) -> Result<Self> {
        let thread = thread
            .as_handle()
            .try_clone_to_owned()
            .map_err(|e| e.to_string())?;
        let mut frames = Box::new(frames);
        let wait = unsafe {
            CreateThreadpoolWait(
                Some(finished),
                Some((&mut *frames as *mut Arc<Mutex<Frames>>).cast()),
                None,
            )
        }
        .map_err(|e| e.to_string())?;
        // No timeout: a completed thread remains signalled even if it exited
        // before registration, so the startup/exit race cannot lose its wake.
        unsafe { SetThreadpoolWait(wait, Some(HANDLE(thread.as_raw_handle())), None) };
        Ok(Self {
            wait,
            _thread: thread,
            _frames: frames,
        })
    }
}
impl Drop for ThreadExit {
    fn drop(&mut self) {
        unsafe {
            SetThreadpoolWait(self.wait, None, None);
            WaitForThreadpoolWaitCallbacks(self.wait, true);
            CloseThreadpoolWait(self.wait);
        }
    }
}
unsafe extern "system" fn finished(
    _: PTP_CALLBACK_INSTANCE,
    context: *mut c_void,
    _: PTP_WAIT,
    _: u32,
) {
    // ThreadExit keeps the allocation alive and drains callbacks before freeing it.
    let frames = unsafe { &*context.cast::<Arc<Mutex<Frames>>>() };
    frames.lock().unwrap_or_else(|e| e.into_inner()).finish();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::lifecycle::Changed;
    use std::{sync::mpsc, thread, time::Duration};

    fn frames() -> (Arc<Mutex<Frames>>, mpsc::Receiver<()>) {
        let (send, receive) = mpsc::channel();
        let changed = Changed::new(move || {
            let _ = send.send(());
        });
        (
            Arc::new(Mutex::new(Frames {
                changed,
                ..Default::default()
            })),
            receive,
        )
    }

    #[test]
    fn capture_thread_exit_notifies_even_when_registration_is_late() {
        for late in [false, true] {
            let (stop, stopping) = mpsc::channel();
            let worker = thread::spawn(move || {
                stopping.recv().unwrap();
            });
            if late {
                stop.send(()).unwrap();
                assert_eq!(
                    unsafe {
                        windows::Win32::System::Threading::WaitForSingleObject(
                            HANDLE(worker.as_raw_handle()),
                            2000,
                        )
                    },
                    windows::Win32::Foundation::WAIT_OBJECT_0
                );
            }
            let (frames, changed) = frames();
            let watcher = ThreadExit::new(&worker, frames.clone()).unwrap();
            if !late {
                stop.send(()).unwrap();
            }
            // Joining closes the original handle; the registration owns its duplicate.
            worker.join().unwrap();
            changed.recv_timeout(Duration::from_secs(2)).unwrap();
            assert!(frames.lock().unwrap().closed);
            drop(watcher);
            assert_eq!(Arc::strong_count(&frames), 1);
            assert!(changed.try_recv().is_err());
        }
    }

    #[test]
    fn capture_thread_exit_wait_can_be_cancelled_before_the_thread_stops() {
        let (stop, stopping) = mpsc::channel();
        let worker = thread::spawn(move || {
            stopping.recv().unwrap();
        });
        let (frames, changed) = frames();
        let watcher = ThreadExit::new(&worker, frames.clone()).unwrap();
        drop(watcher);
        stop.send(()).unwrap();
        worker.join().unwrap();
        assert!(!frames.lock().unwrap().closed);
        assert_eq!(Arc::strong_count(&frames), 1);
        assert!(changed.try_recv().is_err());
    }
}
