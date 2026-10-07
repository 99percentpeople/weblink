//! Demand-driven cursor snapshots. The control actor polls only while a viewer is watching.
use serde::Serialize;
use std::time::{Duration, Instant};
use weblink_desktop_input::{authorization::Grant, input::Rect, session::PointerActivity};

mod assets;
#[cfg(windows)]
mod windows;

pub(super) const INTERVAL: Duration = Duration::from_millis(32);
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum Owner {
    Host,
    #[default]
    Viewer,
}
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
        source_scale: u32,
    },
    Animation {
        frames: Vec<Frame>,
    },
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Frame {
    pub image: Shape,
    pub duration_ms: u32,
}
#[derive(Clone, PartialEq, Eq)]
pub(super) struct Watch {
    pub grant: Grant,
    pub epoch: String,
    pub id: String,
    pub display: Rect,
    pub appearance: bool,
}
pub(super) struct Update {
    pub watch: Watch,
    pub sequence: u32,
    pub shape: Shape,
    pub owner: Owner,
}
pub(super) struct Monitor {
    read: Box<dyn FnMut(Rect) -> Shape + Send>,
    assets: assets::Assets,
    watch: Option<Watch>,
    last_sample: Option<Instant>,
    latest: Option<(Owner, Shape)>,
    activity: PointerActivity,
    owner: Owner,
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
            assets: assets::Assets::default(),
            watch: None,
            last_sample: None,
            latest: None,
            activity: PointerActivity::default(),
            owner: Owner::Viewer,
            sequence: 0,
        }
    }
    pub(super) fn watching(&self) -> bool {
        self.watch.is_some()
    }
    pub(super) fn watch(&mut self, watch: Watch, activity: PointerActivity) {
        if self.watch.as_ref() != Some(&watch) {
            self.cancel();
            self.watch = Some(watch);
            self.activity = activity;
        }
    }
    pub(super) fn cancel(&mut self) {
        self.watch = None;
        self.last_sample = None;
        self.latest = None;
        self.sequence = 0;
        self.assets = assets::Assets::default();
        self.owner = Owner::Viewer;
    }
    pub(super) fn host_owns(&self) -> bool {
        self.owner == Owner::Host
    }
    pub(super) fn observe_activity(&mut self, activity: PointerActivity) {
        if self.watching() && activity.sequence != self.activity.sequence {
            self.activity = activity;
            self.owner = if activity.local {
                Owner::Host
            } else {
                Owner::Viewer
            };
        }
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
        // A host-owned cursor is already in the video: neither capture bitmaps
        // nor publish shape changes until the viewer actually moves it again.
        let shape = if self.host_owns() {
            Shape::Unknown
        } else if watch.appearance {
            (self.read)(watch.display)
        } else {
            Shape::System { name: "default" }
        };
        if self
            .latest
            .as_ref()
            .is_some_and(|(owner, old)| *owner == self.owner && old == &shape)
        {
            return None;
        }
        self.latest = Some((self.owner, shape.clone()));
        self.sequence = self.sequence.checked_add(1)?;
        Some(Update {
            watch: watch.clone(),
            sequence: self.sequence,
            shape,
            owner: self.owner,
        })
    }
    pub(super) fn publish(
        &mut self,
        update: Update,
        send: impl FnOnce(&[serde_json::Value]) -> bool,
    ) {
        if !self.assets.publish(update, send) {
            // Retry the latest observation after backpressure without considering its asset delivered.
            self.latest = None;
        }
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
    fn watch() -> Watch {
        Watch {
            appearance: true,
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
        }
    }
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
        let watch = watch();
        monitor.watch(watch.clone(), PointerActivity::default());
        assert_eq!(monitor.sample(start).unwrap().sequence, 1);
        *value.lock().unwrap() = Shape::System { name: "pointer" };
        assert!(monitor.sample(start + INTERVAL / 2).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        assert_eq!(monitor.sample(start + INTERVAL).unwrap().sequence, 2);
        monitor.watch(watch.clone(), PointerActivity::default());
        assert!(monitor.sample(start + INTERVAL * 2).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 3);
        monitor.watch(
            Watch {
                id: "new".into(),
                ..watch
            },
            PointerActivity::default(),
        );
        assert_eq!(monitor.sample(start + INTERVAL * 2).unwrap().sequence, 1);
        monitor.cancel();
        assert!(monitor.sample(start + INTERVAL * 10).is_none());
        assert_eq!(calls.load(Ordering::Relaxed), 4);
    }
    #[test]
    fn ownership_changes_use_native_order_without_per_move_updates_or_asset_retransmission() {
        let calls = Arc::new(AtomicUsize::new(0));
        let count = calls.clone();
        let mut monitor = Monitor::new(move |_| {
            count.fetch_add(1, Ordering::Relaxed);
            Shape::Image {
                png: "resource".into(),
                width: 32,
                height: 32,
                hotspot_x: 0,
                hotspot_y: 0,
                source_scale: 100,
            }
        });
        let old = PointerActivity {
            sequence: 1,
            local: true,
        };
        monitor.watch(watch(), old);
        let start = Instant::now();
        let update = monitor.sample(start).unwrap();
        assert_eq!(update.owner, Owner::Viewer); // no historical takeover
        monitor.publish(update, |packets| {
            assert_eq!(packets.len(), 2);
            true
        });
        monitor.observe_activity(PointerActivity {
            sequence: 2,
            local: true,
        });
        let update = monitor.sample(start + INTERVAL).unwrap();
        assert_eq!(update.owner, Owner::Host);
        assert_eq!(update.shape, Shape::Unknown);
        monitor.publish(update, |packets| {
            assert_eq!(packets.len(), 1);
            true
        });
        for sequence in 3..10 {
            monitor.observe_activity(PointerActivity {
                sequence,
                local: true,
            });
            assert!(monitor.sample(start + INTERVAL * sequence as u32).is_none());
        }
        assert_eq!(calls.load(Ordering::Relaxed), 1);
        monitor.observe_activity(PointerActivity {
            sequence: 10,
            local: false,
        });
        let update = monitor.sample(start + INTERVAL * 10).unwrap();
        assert_eq!(update.owner, Owner::Viewer);
        monitor.publish(update, |packets| {
            assert_eq!(packets.len(), 1);
            assert_eq!(packets[0]["shape"]["type"], "cached");
            true
        });
        monitor.cancel();
        monitor.observe_activity(PointerActivity {
            sequence: 11,
            local: true,
        });
        assert!(!monitor.host_owns());
        monitor.watch(
            Watch {
                appearance: false,
                ..watch()
            },
            old,
        );
        assert_eq!(
            monitor.sample(start).unwrap().shape,
            Shape::System { name: "default" }
        );
        assert_eq!(calls.load(Ordering::Relaxed), 2); // appearance-disabled watches never capture PNGs
    }
}
