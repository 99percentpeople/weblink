use super::super::{Setting, Status};
use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};

struct Resource(Arc<AtomicUsize>);
impl Drop for Resource {
    fn drop(&mut self) {
        self.0.fetch_add(1, Ordering::SeqCst);
    }
}

#[test]
fn resource_is_applied_once_and_restored_after_the_last_out_of_order_release() {
    let resources = Arc::new(Registry::default());
    let restored = Arc::new(AtomicUsize::new(0));
    let first = resources.acquire(7, || Resource(restored.clone()));
    let second = resources.acquire(7, || panic!("must reuse the live device"));
    let other_device = resources.acquire(8, || Resource(restored.clone()));
    drop(first);
    assert_eq!(restored.load(Ordering::SeqCst), 0);
    drop(other_device);
    assert_eq!(restored.load(Ordering::SeqCst), 1);
    drop(second);
    assert_eq!(restored.load(Ordering::SeqCst), 2);
    drop(resources.acquire(7, || Resource(restored.clone())));
    assert_eq!(restored.load(Ordering::SeqCst), 3);
}

#[test]
fn rejected_adjustment_is_shared_without_retry_storm_and_retried_next_session() {
    let resources = Arc::new(Registry::default());
    let first = resources.acquire((), || {
        Setting::<Resource>::from_result(Err("permission denied".into()))
    });
    let second = resources.acquire((), || panic!("failed request is still shared"));
    assert_eq!(
        first.inspect(|s| s.status.clone()),
        Status::Failed("permission denied".into())
    );
    drop(first);
    drop(second);
    let restored = Arc::new(AtomicUsize::new(0));
    let next = resources.acquire((), || {
        Setting::from_result(Ok(Some(Resource(restored.clone()))))
    });
    assert_eq!(next.inspect(|s| s.status.clone()), Status::Applied);
    drop(next);
    assert_eq!(restored.load(Ordering::SeqCst), 1);
}

#[test]
fn reacquisition_waits_for_the_previous_restore() {
    use std::{sync::mpsc, thread, time::Duration};
    struct BlockingResource {
        value: Arc<AtomicUsize>,
        previous: usize,
        restoring: Option<mpsc::Sender<()>>,
        release: Option<mpsc::Receiver<()>>,
    }
    impl Drop for BlockingResource {
        fn drop(&mut self) {
            if let Some(started) = self.restoring.take() {
                started.send(()).unwrap();
                self.release.take().unwrap().recv().unwrap();
            }
            self.value.store(self.previous, Ordering::SeqCst);
        }
    }
    let registry = Arc::new(Registry::default());
    let value = Arc::new(AtomicUsize::new(0));
    let (restoring, waiting) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let first = registry.acquire((), || BlockingResource {
        previous: value.swap(7, Ordering::SeqCst),
        value: value.clone(),
        restoring: Some(restoring),
        release: Some(released),
    });
    let ending = thread::spawn(move || drop(first));
    waiting.recv_timeout(Duration::from_secs(2)).unwrap();
    let (started, started_rx) = mpsc::channel();
    let (entered, entered_rx) = mpsc::channel();
    let next_value = value.clone();
    let next = thread::spawn(move || {
        started.send(()).unwrap();
        registry.acquire((), || {
            entered.send(()).unwrap();
            BlockingResource {
                previous: next_value.swap(7, Ordering::SeqCst),
                value: next_value,
                restoring: None,
                release: None,
            }
        })
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let premature = entered_rx.recv_timeout(Duration::from_millis(50)).is_ok();
    release.send(()).unwrap();
    ending.join().unwrap();
    let next = next.join().unwrap();
    assert!(
        !premature,
        "new baseline was read before the previous override was restored"
    );
    assert_eq!(value.load(Ordering::SeqCst), 7);
    drop(next);
    assert_eq!(value.load(Ordering::SeqCst), 0);
}
