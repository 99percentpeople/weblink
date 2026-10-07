//! Ordered, watch-scoped definitions. A bounded ring of slots avoids cache-miss round trips.
use super::{Frame, Shape, Update};
use serde_json::{json, Value};

pub(super) const SLOTS: usize = 16;
pub(super) const MAX_FRAMES: usize = 64;
pub(super) const MAX_BYTES: usize = 256 * 1024;
pub(super) const MAX_PIXELS: usize = 1024 * 1024;

#[derive(Default)]
pub(super) struct Assets {
    slots: Vec<Shape>,
    next: usize,
}
impl Assets {
    pub(super) fn publish(&mut self, update: Update, send: impl FnOnce(&[Value]) -> bool) -> bool {
        let watch = update.watch;
        let mut messages = Vec::new();
        let mut replacement = None;
        let shape;
        if matches!(update.shape, Shape::Image { .. } | Shape::Animation { .. }) {
            let slot = if let Some(slot) =
                self.slots.iter().position(|shape| *shape == update.shape)
            {
                slot
            } else {
                let frames = match &update.shape {
                    Shape::Animation { frames } => frames.clone(),
                    image => vec![Frame {
                        image: image.clone(),
                        duration_ms: 100,
                    }],
                };
                for (index, frame) in frames.iter().enumerate() {
                    let image = frames[..index]
                        .iter()
                        .position(|previous| previous.image == frame.image)
                        .map_or_else(|| json!(frame.image), |previous| json!(previous));
                    messages.push(json!({"type":"cursor-asset", "grantId":watch.grant.id,
                        "inputEpoch":watch.epoch, "watchId":watch.id, "assetId":self.next,
                        "index":index, "count":frames.len(), "image":image, "durationMs":frame.duration_ms}));
                }
                replacement = Some(update.shape);
                self.next
            };
            shape = json!({"type":"cached", "assetId":slot});
        } else {
            shape = serde_json::to_value(&update.shape).unwrap();
        }
        messages.push(json!({"type":"cursor-state", "grantId":watch.grant.id,
            "inputEpoch":watch.epoch, "watchId":watch.id, "sequence":update.sequence, "shape":shape, "owner":update.owner}));
        if !send(&messages) {
            return false;
        }
        if let Some(shape) = replacement {
            if self.next == self.slots.len() {
                self.slots.push(shape);
            } else {
                self.slots[self.next] = shape;
            }
            self.next = (self.next + 1) % SLOTS;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::remote_control::cursor::Watch;
    use weblink_desktop_input::{
        authorization::{Binding, Grant},
        input::Rect,
        protocol::Target,
    };

    fn update(shape: Shape) -> Update {
        Update {
            watch: Watch {
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
                            geometry_revision: "geometry".into(),
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
            },
            sequence: 1,
            shape,
            owner: super::super::Owner::Viewer,
        }
    }
    fn image(id: usize) -> Shape {
        Shape::Image {
            png: id.to_string(),
            width: 32,
            height: 32,
            hotspot_x: 0,
            hotspot_y: 0,
            source_scale: 100,
        }
    }
    #[test]
    fn pushes_frames_before_use_and_reuses_cached_assets_without_requests() {
        let mut assets = Assets::default();
        let animation = Shape::Animation {
            frames: vec![
                Frame {
                    image: image(1),
                    duration_ms: 50,
                },
                Frame {
                    image: image(2),
                    duration_ms: 100,
                },
            ],
        };
        assert!(assets.publish(update(animation.clone()), |messages| {
            assert_eq!(messages.len(), 3);
            assert_eq!(messages[0]["type"], "cursor-asset");
            assert_eq!(messages[1]["durationMs"], 100);
            assert_eq!(messages[2]["shape"], json!({"type":"cached", "assetId":0}));
            true
        }));
        assert!(assets.publish(update(image(3)), |_| true));
        assert!(assets.publish(update(animation), |messages| {
            assert_eq!(messages.len(), 1);
            assert_eq!(messages[0]["shape"], json!({"type":"cached", "assetId":0}));
            true
        }));
    }
    #[test]
    fn failed_batches_do_not_poison_cache_and_slot_replacement_is_explicit() {
        let mut assets = Assets::default();
        assert!(!assets.publish(update(image(0)), |_| false));
        for id in 0..=SLOTS {
            assert!(assets.publish(update(image(id)), |messages| {
                assert_eq!(messages.len(), 2);
                assert_eq!(messages[0]["index"], 0);
                assert_eq!(messages[0]["assetId"], id % SLOTS);
                true
            }));
        }
        assert!(assets.publish(update(image(0)), |messages| {
            assert_eq!(messages.len(), 2);
            assert_eq!(messages[0]["assetId"], 1);
            true
        }));
    }
}
