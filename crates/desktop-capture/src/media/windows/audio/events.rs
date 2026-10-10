//! Owned WASAPI packet and stop signals. A quiet device needs no timeout wakeups.
use crate::Result;
use std::sync::atomic::{AtomicBool, Ordering};
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0},
    System::Threading::{CreateEventW, SetEvent, WaitForMultipleObjects, INFINITE},
};

struct Event(HANDLE);
// Kernel events support concurrent signaling/waiting. Events live until the
// last owner (including the waiting worker) releases its Arc<Events>.
unsafe impl Send for Event {}
unsafe impl Sync for Event {}
impl Event {
    fn new(manual_reset: bool) -> Result<Self> {
        unsafe { CreateEventW(None, manual_reset, false, None) }
            .map(Self)
            .map_err(|e| e.to_string())
    }
}
impl Drop for Event {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

pub(super) struct Events {
    packet: Event,
    stop: Event,
    stopped: AtomicBool,
}
impl Events {
    pub fn new() -> Result<Self> {
        Ok(Self {
            packet: Event::new(false)?,
            stop: Event::new(true)?,
            stopped: AtomicBool::new(false),
        })
    }
    pub fn packet_handle(&self) -> HANDLE {
        self.packet.0
    }
    pub fn stopped(&self) -> bool {
        self.stopped.load(Ordering::Acquire)
    }
    pub fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        let _ = unsafe { SetEvent(self.stop.0) };
    }
    /// A stop that races with a packet takes priority; stop remains signaled.
    pub fn wait(&self) -> Result<bool> {
        let result =
            unsafe { WaitForMultipleObjects(&[self.stop.0, self.packet.0], false, INFINITE) };
        if result == WAIT_OBJECT_0 {
            Ok(false)
        } else if result.0 == WAIT_OBJECT_0.0 + 1 {
            Ok(!self.stopped())
        } else {
            Err(format!(
                "System audio event failed: {}",
                windows::core::Error::from_thread()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        sync::{mpsc, Arc},
        thread,
        time::Duration,
    };

    #[test]
    fn packet_and_stop_wake_the_worker_without_periodic_checks() {
        let events = Arc::new(Events::new().unwrap());
        let worker_events = events.clone();
        let (tx, rx) = mpsc::channel();
        let worker = thread::spawn(move || {
            tx.send(worker_events.wait()).unwrap();
            tx.send(worker_events.wait()).unwrap();
        });
        unsafe { SetEvent(events.packet_handle()) }.unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap());
        events.stop();
        assert!(!rx.recv_timeout(Duration::from_secs(2)).unwrap().unwrap());
        worker.join().unwrap();
    }

    #[test]
    fn stop_before_wait_is_sticky_and_wins_over_a_pending_packet() {
        let events = Events::new().unwrap();
        unsafe { SetEvent(events.packet_handle()) }.unwrap();
        events.stop();
        assert!(events.stopped());
        assert!(!events.wait().unwrap());
        events.stop();
        assert!(!events.wait().unwrap());
    }
}
