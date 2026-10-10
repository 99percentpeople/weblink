use super::*;
use crate::lifecycle::{Changed, Subscription};
#[cfg(windows)]
mod windows;

fn notifications() -> (Changed, mpsc::Receiver<()>) {
    let (send, receive) = mpsc::channel();
    (
        Changed::new(move || {
            let _ = send.send(());
        }),
        receive,
    )
}

#[test]
fn active_wait_uses_lease_deadline_and_wakes_on_notification() {
    let (mut engine, _) = setup();
    start(&mut engine);
    let deadline = engine.deadline().unwrap();
    assert!(deadline.duration_since(Instant::now()) > Duration::from_secs(59));
    let (send, receive) = mpsc::channel();
    let (reply, result) = mpsc::channel();
    let worker = thread::spawn(move || {
        reply
            .send(receive_command(&receive, Some(deadline)))
            .unwrap();
    });
    assert!(matches!(
        result.recv_timeout(Duration::from_millis(350)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    send.send(()).unwrap();
    assert_eq!(result.recv_timeout(Duration::from_secs(1)).unwrap(), Ok(()));
    worker.join().unwrap();
}

#[test]
fn deadline_tracks_earliest_session_and_renewal_without_status_extending_it() {
    let (mut engine, _) = setup();
    assert!(engine.deadline().is_none());
    let first = start(&mut engine);
    let second = start(&mut engine);
    let now = engine.active[&first].heartbeat;
    engine.active.get_mut(&second).unwrap().heartbeat = now + Duration::from_secs(2);
    assert_eq!(engine.deadline(), Some(now + LEASE));
    engine.renew(&first, now + Duration::from_secs(10)).unwrap();
    let due = now + Duration::from_secs(2) + LEASE;
    assert_eq!(engine.deadline(), Some(due));
    engine
        .status(&second, now + Duration::from_secs(30))
        .unwrap();
    assert_eq!(engine.deadline(), Some(due));
    engine.tick(due);
    assert!(!engine.active.contains_key(&second));
    assert!(engine.active.contains_key(&first));
    assert!(engine.renew(&second, due).is_err());
    engine.stop(&first, due).unwrap();
    assert!(engine.deadline().is_none());
}

#[test]
fn frame_counts_do_not_wake_owner_and_state_bursts_coalesce_without_losing_exit() {
    let (changed, receive) = notifications();
    let mut frames = Frames {
        changed: changed.clone(),
        ..Default::default()
    };
    frames.arrived(640, 480, Instant::now());
    receive.try_recv().unwrap();
    changed.acknowledge();
    for _ in 0..1000 {
        frames.arrived(640, 480, Instant::now());
    }
    assert!(
        receive.try_recv().is_err(),
        "steady frames must not drive the actor"
    );
    frames.arrived(1280, 720, Instant::now());
    frames.arrived(1920, 1080, Instant::now());
    frames.finish();
    receive.try_recv().unwrap();
    assert!(receive.try_recv().is_err());
    changed.acknowledge();
    assert!(frames.closed);
    assert_eq!((frames.width, frames.height), (1920, 1080));
    // Another producer changing state after acknowledgment gets its own wake.
    changed.notify();
    receive.try_recv().unwrap();
    changed.acknowledge();
    frames.finish();
    assert!(
        receive.try_recv().is_err(),
        "duplicate exit must not keep waking"
    );
}

#[test]
fn media_notification_subscription_detaches_and_can_be_replaced() {
    let subscription = Subscription::default();
    subscription.notify();
    let (first, receive) = notifications();
    subscription.set(first.clone());
    subscription.notify();
    receive.try_recv().unwrap();
    first.acknowledge();
    subscription.set(Default::default());
    subscription.notify();
    assert!(receive.try_recv().is_err());
    let (next, receive_next) = notifications();
    subscription.set(next);
    subscription.notify();
    receive_next.try_recv().unwrap();
    assert!(receive.try_recv().is_err());
}

fn service() -> (CaptureService, mpsc::Receiver<Arc<Mutex<Frames>>>) {
    let (send, receive) = mpsc::channel();
    let service = CaptureService::with_backend(move || {
        let fake = Fake {
            frame_events: Some(send),
            ..Default::default()
        };
        fake.available.set(true);
        fake
    })
    .unwrap();
    (service, receive)
}

#[test]
fn owner_delivers_resize_and_source_exit_without_queries_or_renewals() {
    let (service, sources) = service();
    let id = service
        .start("selected".into())
        .unwrap()
        .session_id
        .unwrap();
    let frames = sources.recv_timeout(Duration::from_secs(1)).unwrap();
    let (send, receive) = mpsc::channel();
    service
        .watch(
            id.clone(),
            "view".into(),
            Box::new(move |s| send.send(s).is_ok()),
        )
        .unwrap();
    assert_eq!(receive.recv().unwrap().state, CaptureState::Running);
    frames.lock().unwrap().arrived(1280, 720, Instant::now());
    let resized = receive.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!((resized.width, resized.height), (1280, 720));
    frames.lock().unwrap().finish();
    let stopped = receive.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(stopped.state, CaptureState::Closed);
    assert_eq!(stopped.stop_reason, Some(StopReason::SourceClosed));
    assert!(service.renew(id).is_err());
    service.shutdown();
}

#[test]
fn retired_source_notifications_cannot_close_a_new_session_and_shutdown_wakes_idle_owner() {
    let (service, sources) = service();
    let old = service
        .start("selected".into())
        .unwrap()
        .session_id
        .unwrap();
    let retired = sources.recv_timeout(Duration::from_secs(1)).unwrap();
    service.stop(old).unwrap();
    let current = service
        .start("selected".into())
        .unwrap()
        .session_id
        .unwrap();
    let frames = sources.recv_timeout(Duration::from_secs(1)).unwrap();
    retired.lock().unwrap().finish();
    assert_eq!(
        service.status(current.clone()).unwrap().state,
        CaptureState::Running
    );
    assert!(!frames.lock().unwrap().closed);
    service.stop(current).unwrap();
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        service.shutdown();
        done.send(()).unwrap();
    });
    finished.recv_timeout(Duration::from_secs(1)).unwrap();
}
