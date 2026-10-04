//! Bounded preview demand and new-frame notifications. Pixels use the pull handshake.
use super::MediaSession;
use crate::{media::preview::PreviewEvent, Result};
use std::{
    collections::HashMap,
    sync::{atomic::Ordering, Arc, Weak},
};

pub(super) struct Watch {
    visible: bool,
    delivered: u64,
    notified: bool,
    send: Box<dyn Fn(PreviewEvent) -> bool + Send + Sync>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::MediaOptions;
    use std::sync::Mutex;

    #[test]
    fn coalesces_frames_rearms_racing_ack_and_releases_hidden_or_closed_consumers() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _enter = runtime.enter();
        let media = MediaSession::new(MediaOptions::default()).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let received = events.clone();
        let watch = media
            .subscribe_preview(true, move |event| {
                received.lock().unwrap().push(event);
                true
            })
            .unwrap();
        assert!(media.has_consumers());
        for sequence in 1..=100 {
            media.latest_sequence.store(sequence, Ordering::Release);
            media.notify_previews(sequence);
        }
        assert_eq!(events.lock().unwrap().len(), 2); // visibility + one outstanding notification
        watch.acknowledge(99);
        assert_eq!(events.lock().unwrap().len(), 3); // frame 100 raced with the read
        watch.acknowledge(100);
        assert_eq!(events.lock().unwrap().len(), 3);
        watch.set_visible(false);
        assert!(!media.has_consumers());
        media.latest_sequence.store(101, Ordering::Release);
        media.notify_previews(101);
        assert_eq!(events.lock().unwrap().len(), 4);
        watch.set_visible(true);
        assert_eq!(events.lock().unwrap().len(), 6);
        assert!(media.has_consumers());
        media.close();
        assert!(matches!(
            events.lock().unwrap().last(),
            Some(PreviewEvent::Ended)
        ));
        assert!(!media.has_consumers());
        drop(watch);
    }

    #[test]
    fn dropping_or_failing_a_subscription_removes_its_demand() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let _enter = runtime.enter();
        let media = MediaSession::new(MediaOptions::default()).unwrap();
        let watch = media.subscribe_preview(true, |_| true).unwrap();
        drop(watch);
        assert!(!media.has_consumers());
        let _watch = media
            .subscribe_preview(true, |event| !matches!(event, PreviewEvent::Frame))
            .unwrap();
        media.notify_previews(1);
        assert!(!media.has_consumers());
        media.close();
    }
}
pub(super) type Watches = HashMap<String, Watch>;
impl Watch {
    fn notify(&mut self, sequence: u64) -> bool {
        if !self.visible || self.notified || sequence <= self.delivered {
            return true;
        }
        self.notified = true;
        (self.send)(PreviewEvent::Frame)
    }
}
/// Release the consumer on drop. The callback must not reenter MediaSession.
pub struct PreviewSubscription {
    media: Weak<MediaSession>,
    id: String,
}
impl PreviewSubscription {
    pub fn set_visible(&self, visible: bool) {
        let Some(media) = self.media.upgrade() else {
            return;
        };
        let mut watches = media.previews.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(watch) = watches.get_mut(&self.id) {
            if watch.visible == visible {
                return;
            }
            watch.visible = visible;
            watch.notified = false;
            if !(watch.send)(PreviewEvent::Visibility { visible })
                || !watch.notify(media.latest_sequence.load(Ordering::Acquire))
            {
                watches.remove(&self.id);
            }
            media.notify.notify_one();
        }
    }
    /// Acknowledge pixels already copied; a concurrently newer frame is notified again.
    pub fn acknowledge(&self, sequence: u64) {
        let Some(media) = self.media.upgrade() else {
            return;
        };
        let mut watches = media.previews.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(watch) = watches.get_mut(&self.id) {
            watch.delivered = sequence;
            watch.notified = false;
            if !watch.notify(media.latest_sequence.load(Ordering::Acquire)) {
                watches.remove(&self.id);
                media.notify.notify_one();
            }
        }
    }
}
impl Drop for PreviewSubscription {
    fn drop(&mut self) {
        if let Some(media) = self.media.upgrade() {
            media
                .previews
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .remove(&self.id);
            media.notify.notify_one();
        }
    }
}
impl MediaSession {
    pub fn subscribe_preview(
        self: &Arc<Self>,
        visible: bool,
        send: impl Fn(PreviewEvent) -> bool + Send + Sync + 'static,
    ) -> Result<PreviewSubscription> {
        let mut watches = self.previews.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) || watches.len() >= 32 {
            return Err("Preview unavailable or limit reached".into());
        }
        let mut watch = Watch {
            visible,
            delivered: 0,
            notified: false,
            send: Box::new(send),
        };
        if !(watch.send)(PreviewEvent::Visibility { visible })
            || !watch.notify(self.latest_sequence.load(Ordering::Acquire))
        {
            return Err("Preview channel closed".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        watches.insert(id.clone(), watch);
        self.notify.notify_one();
        Ok(PreviewSubscription {
            media: Arc::downgrade(self),
            id,
        })
    }
    pub(super) fn has_consumers(&self) -> bool {
        !self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_empty()
            || self
                .previews
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .values()
                .any(|watch| watch.visible)
    }
    pub(super) fn notify_previews(&self, sequence: u64) {
        self.previews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, watch| watch.notify(sequence));
    }
    pub(super) fn end_previews(&self) {
        for (_, watch) in self
            .previews
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain()
        {
            (watch.send)(PreviewEvent::Ended);
        }
    }
}
