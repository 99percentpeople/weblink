//! Both FFI markers use Rust's monotonic clock; no cross-language clock conversion.
use super::super::hardware::stages::OutputTiming;
use crate::Result;
use std::{sync::Mutex, time::Instant};

#[derive(Default)]
struct Markers {
    ready: Option<Instant>,
    started: Option<Instant>,
}

#[derive(Default)]
pub(super) struct Timings {
    // Must match bridge.cpp kSlots. A slot is reused only after poll consumes it.
    slots: [Mutex<Markers>; 4],
}
impl Timings {
    pub fn mark(&self, slot: u32, phase: u32, now: Instant) {
        let Some(slot) = self.slots.get(slot as usize) else {
            return;
        };
        let mut markers = slot.lock().unwrap_or_else(|e| e.into_inner());
        match phase {
            0 => {
                markers.ready = Some(now);
                markers.started = None;
            }
            1 => markers.started = Some(now),
            _ => {}
        }
    }
    pub fn take(&self, slot: u32, finished: Instant) -> Result<OutputTiming> {
        let slot = self
            .slots
            .get(slot as usize)
            .ok_or("Invalid NVENC timing slot")?;
        let markers = std::mem::take(&mut *slot.lock().unwrap_or_else(|e| e.into_inner()));
        let ready = markers.ready.ok_or("Missing NVENC completion timestamp")?;
        let started = markers.started.ok_or("Missing NVENC output timestamp")?;
        if ready > started || started > finished {
            return Err("Invalid NVENC timing order".into());
        }
        Ok(OutputTiming {
            ready,
            started,
            finished,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn slots_keep_independent_timestamps_and_clear_on_reuse() {
        let timings = Timings::default();
        let now = Instant::now();
        for slot in 0..4 {
            timings.mark(slot, 0, now + Duration::from_millis(slot as u64));
        }
        for slot in (0..4).rev() {
            timings.mark(slot, 1, now + Duration::from_millis(10));
            let output = timings.take(slot, now + Duration::from_millis(12)).unwrap();
            assert_eq!(output.ready, now + Duration::from_millis(slot as u64));
            assert_eq!(output.started, now + Duration::from_millis(10));
            assert!(timings.take(slot, now).is_err());
        }
        timings.mark(0, 0, now);
        assert!(
            timings.take(0, now).is_err(),
            "Old output start leaked into a reused slot"
        );
        assert!(timings.take(4, now).is_err());
    }
}
