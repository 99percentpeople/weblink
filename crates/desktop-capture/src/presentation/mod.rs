//! Shared native presentation for capture preview and decoded screen reception.
mod compositor;
mod recording;
mod source;
pub mod upload;
mod wake;
pub use compositor::{Compositor, Layout};
pub use recording::Recording;
pub use source::{Frame, Source, Stats, Subscription, Texture};
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    };
    #[test]
    fn layout_rejects_untrusted_nonfinite_and_unbounded_coordinates() {
        assert!(Layout::default().validate().is_ok());
        for value in [f32::NAN, f32::INFINITY, 32769.] {
            assert!(Layout {
                x: value,
                ..Default::default()
            }
            .validate()
            .is_err());
        }
        assert!(Layout {
            width: -1.,
            ..Default::default()
        }
        .validate()
        .is_err());
    }
    #[test]
    fn subscription_owns_demand_and_close_notifies_without_lock_reentry() {
        let source = Arc::new(Source::default());
        let weak = Arc::downgrade(&source);
        let calls = Arc::new(AtomicU64::new(0));
        let count = calls.clone();
        let watch = source.subscribe(Arc::new(move || {
            let _ = weak.upgrade().unwrap().latest();
            count.fetch_add(1, Ordering::Relaxed);
        }));
        assert!(source.active());
        source.close();
        assert_eq!(calls.load(Ordering::Relaxed), 2);
        drop(watch);
        assert!(!source.active());
    }
    #[test]
    fn visibility_demand_and_subscriptions_do_not_retain_source() {
        for _ in 0..24 {
            let source = Arc::new(Source::default());
            let weak = Arc::downgrade(&source);
            let watch = source.subscribe(Arc::new(|| {}));
            let observer = source.observe(Arc::new(|| {}), false);
            assert!(source.active());
            watch.set_active(false);
            assert!(!source.active());
            watch.set_active(true);
            assert!(source.active());
            drop(watch);
            assert!(!source.active());
            source.close();
            drop(source);
            assert!(weak.upgrade().is_none());
            drop(observer);
        }
    }
}
