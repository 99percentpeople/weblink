//! Demand-driven cursor snapshots. The control actor polls only while a viewer is watching.
use serde::Serialize;
use std::time::{Duration, Instant};
use weblink_desktop_input::{authorization::Grant, input::Rect};

#[cfg(windows)]
mod windows;

pub(super) const INTERVAL: Duration = Duration::from_millis(32);
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(super) enum Shape {
    Unknown,
    System {
        name: &'static str,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        png: String,
        width: u32,
        height: u32,
        hotspot_x: u32,
        hotspot_y: u32,
    },
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Watch {
    pub grant: Grant,
    pub epoch: String,
    pub id: String,
    pub display: Rect,
}
pub(super) struct Update {
    pub watch: Watch,
    pub sequence: u32,
    pub shape: Shape,
}
pub(super) struct Monitor {
    read: Box<dyn FnMut(Rect) -> Shape + Send>,
    watch: Option<Watch>,
    last_sample: Option<Instant>,
    latest: Option<Shape>,
    sequence: u32,
}
impl Default for Monitor {
    fn default() -> Self {
        #[cfg(windows)]
        {
            let mut detector = windows::Detector::default();
            Self::new(move |display| detector.read(display))
        }
        #[cfg(not(windows))]
        Self::new(|_| Shape::Unknown)
    }
}
impl Monitor {
    pub(super) fn new(read: impl FnMut(Rect) -> Shape + Send + 'static) -> Self {
        Self {
            read: Box::new(read),
            watch: None,
            last_sample: None,
            latest: None,
            sequence: 0,
        }
    }
    pub(super) fn watching(&self) -> bool {
        self.watch.is_some()
    }
    pub(super) fn watch(&mut self, watch: Watch) {
        if self.watch.as_ref() != Some(&watch) {
            self.cancel();
            self.watch = Some(watch);
        }
    }
    pub(super) fn cancel(&mut self) {
        self.watch = None;
        self.last_sample = None;
        self.latest = None;
        self.sequence = 0;
    }
    pub(super) fn due(&self, now: Instant) -> bool {
        self.watching()
            && self
                .last_sample
                .is_none_or(|at| now.duration_since(at) >= INTERVAL)
    }
    pub(super) fn sample(&mut self, now: Instant) -> Option<Update> {
        if !self.due(now) {
            return None;
        }
        let watch = self.watch.as_ref()?;
        self.last_sample = Some(now);
        let shape = (self.read)(watch.display);
        if self.latest.as_ref() == Some(&shape) {
            return None;
        }
        self.latest = Some(shape.clone());
        self.sequence = self.sequence.checked_add(1)?;
        Some(Update {
            watch: watch.clone(),
            sequence: self.sequence,
            shape,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    };
    use weblink_desktop_input::{authorization::Binding, protocol::Target};
    #[test]
    fn cursor_monitor_is_demand_driven_throttled_and_sends_only_changes() {
        let value = Arc::new(Mutex::new(Shape::System { name: "text" }));
        let shared = value.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut monitor = Monitor::new(move |_| {
            count.fetch_add(1, Ordering::Relaxed);
            shared.lock().unwrap().clone()
        });
        let start = Instant::now();
        assert!(monitor.sample(start).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 0);
        let watch = Watch {
            grant: Grant {
                id: "grant".into(),
                binding: Binding {
                    room_generation: "room".into(),
                    peer_generation: "peer".into(),
                    client_id: "client".into(),
                    capture_session_id: "capture".into(),
                    target: Target {
                        source_id: "source".into(),
                        media_id: "media".into(),
                        geometry_revision: "layout".into(),
                    },
                },
            },
            epoch: "epoch".into(),
            id: "watch".into(),
            display: Rect {
                left: 0,
                top: 0,
                width: 1920,
                height: 1080,
            },
        };
        monitor.watch(watch.clone());
        assert_eq!(monitor.sample(start).unwrap().sequence, 1);
        *value.lock().unwrap() = Shape::System { name: "pointer" };
        assert!(monitor.sample(start + INTERVAL / 2).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(monitor.sample(start + INTERVAL).unwrap().sequence, 2);
        monitor.watch(watch.clone());
        assert!(monitor.sample(start + INTERVAL * 2).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        monitor.watch(Watch {
            id: "new".into(),
            ..watch
        });
        assert_eq!(monitor.sample(start + INTERVAL * 2).unwrap().sequence, 1);
        monitor.cancel();
        assert!(monitor.sample(start + INTERVAL * 10).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 4);
    }
}
