//! Wait for one copy operation. Events are hints; the sequence remains authoritative.
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

pub(super) fn wait_for_sequence<W>(
    after: u32,
    timeout: Duration,
    mut sequence: impl FnMut() -> u32,
    listen: impl FnOnce(Box<dyn Fn() + Send>) -> Result<W, String>,
) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    if sequence() != after {
        return Ok(());
    }
    let (send, receive) = mpsc::sync_channel(1);
    let _listener = listen(Box::new(move || {
        // Clipboard bursts need only one pending wake and never block the pump.
        let _ = send.try_send(());
    }))?;
    loop {
        // Subscribe before rechecking: a copy during registration cannot be lost.
        if sequence() != after {
            return Ok(());
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err("The remote application did not copy new content".into());
        }
        match receive.recv_timeout(remaining) {
            Ok(()) => (),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Resolve a notification that raced the deadline using current state.
                return if sequence() != after {
                    Ok(())
                } else {
                    Err("The remote application did not copy new content".into())
                };
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Clipboard listener stopped".into());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
        Arc,
    };

    struct Listener {
        _callback: Box<dyn Fn() + Send>,
        stopped: Arc<AtomicBool>,
    }
    impl Drop for Listener {
        fn drop(&mut self) {
            self.stopped.store(true, Ordering::Release);
        }
    }

    #[test]
    fn already_copied_content_does_not_create_a_listener() {
        wait_for_sequence(
            1,
            Duration::from_secs(1),
            || 2,
            |_| -> Result<(), String> { panic!("already changed") },
        )
        .unwrap();
    }

    #[test]
    fn copy_during_registration_is_observed_and_releases_the_listener() {
        let sequence = AtomicU32::new(1);
        let stopped = Arc::new(AtomicBool::new(false));
        wait_for_sequence(
            1,
            Duration::from_secs(1),
            || sequence.load(Ordering::Acquire),
            |callback| {
                sequence.store(2, Ordering::Release);
                callback();
                Ok(Listener {
                    _callback: callback,
                    stopped: stopped.clone(),
                })
            },
        )
        .unwrap();
        assert!(stopped.load(Ordering::Acquire));
    }

    #[test]
    fn quiet_clipboard_is_not_polled_and_timeout_releases_the_listener() {
        let reads = AtomicUsize::new(0);
        let stopped = Arc::new(AtomicBool::new(false));
        let result = wait_for_sequence(
            1,
            Duration::from_millis(80),
            || {
                reads.fetch_add(1, Ordering::AcqRel);
                1
            },
            |callback| {
                Ok(Listener {
                    _callback: callback,
                    stopped: stopped.clone(),
                })
            },
        );
        assert_eq!(
            result.unwrap_err(),
            "The remote application did not copy new content"
        );
        assert_eq!(reads.load(Ordering::Acquire), 3);
        assert!(stopped.load(Ordering::Acquire));
    }

    #[test]
    fn a_notification_wakes_the_waiter_without_a_retry_timer() {
        let sequence = Arc::new(AtomicU32::new(1));
        let current = sequence.clone();
        let (registered, subscription) = mpsc::channel();
        let stopped = Arc::new(AtomicBool::new(false));
        let released = stopped.clone();
        let worker = std::thread::spawn(move || {
            wait_for_sequence(
                1,
                Duration::from_secs(2),
                || current.load(Ordering::Acquire),
                |callback| {
                    let callback = Arc::new(std::sync::Mutex::new(callback));
                    registered.send(callback.clone()).unwrap();
                    Ok(Listener {
                        _callback: Box::new(move || callback.lock().unwrap()()),
                        stopped: released,
                    })
                },
            )
        });
        let callback = subscription.recv_timeout(Duration::from_secs(1)).unwrap();
        sequence.store(2, Ordering::Release);
        callback.lock().unwrap()();
        worker.join().unwrap().unwrap();
        assert!(stopped.load(Ordering::Acquire));
    }
}
