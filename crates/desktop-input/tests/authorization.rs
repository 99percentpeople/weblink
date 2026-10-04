use std::{
    cell::RefCell,
    rc::Rc,
    time::{Duration, Instant},
};
use weblink_desktop_input::{
    authorization::{Authority, Backend, Binding, Grant, RequestResult},
    protocol::{DenialReason, RevocationReason, Signal, Target},
};

#[derive(Clone, Default)]
struct Fake {
    current: Rc<RefCell<Vec<Binding>>>,
    released: Rc<RefCell<Vec<Grant>>>,
    fail_release: Rc<std::cell::Cell<bool>>,
}
impl Backend for Fake {
    fn is_current(&self, binding: &Binding) -> bool {
        self.current.borrow().contains(binding)
    }
    fn release(&mut self, grant: &Grant) -> bool {
        self.released.borrow_mut().push(grant.clone());
        assert!(!self.fail_release.get(), "release failed");
        true
    }
}

#[test]
fn failed_cleanup_keeps_authority_closed_even_if_the_owner_catches_the_panic() {
    let (mut a, fake, b, now) = setup();
    let id = grant(&mut a, &b, now);
    fake.fail_release.set(true);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.revoke())).is_err());
    assert!(!a.register(b.clone()));
    assert!(!a.permits(&b, &id, now));
    assert!(a.request("media-1", &request(&b, "new"), now).is_none());
}

#[test]
fn idle_wait_is_unbounded_but_active_waits_preserve_consent_and_lease_deadlines() {
    let (mut authority, _, binding, now) = setup();
    assert_eq!(authority.wait_duration(now), None);
    let consent = pending(&mut authority, &binding, "request", now);
    assert_eq!(
        authority.wait_duration(now),
        Some(Duration::from_millis(100))
    );
    let almost_consent =
        now + Duration::from_millis(weblink_desktop_input::protocol::REQUEST_TIMEOUT_MS - 5);
    assert_eq!(
        authority.wait_duration(almost_consent),
        Some(Duration::from_millis(5))
    );
    authority.approve(&consent, now).unwrap();
    let deadline = now + Duration::from_millis(weblink_desktop_input::protocol::LEASE_MS);
    assert_eq!(
        authority.wait_duration(deadline - Duration::from_millis(5)),
        Some(Duration::from_millis(5))
    );
    assert_eq!(authority.wait_duration(deadline), Some(Duration::ZERO));
    authority.tick(deadline);
    assert_eq!(
        authority.wait_duration(deadline),
        Some(Duration::from_millis(100))
    );
    authority.revoke();
    assert_eq!(authority.wait_duration(deadline), None);
}

#[test]
fn request_deduplication_is_bounded_and_recovers_after_its_window() {
    let (mut a, _, b, now) = setup();
    for i in 0..256 {
        let consent = pending(&mut a, &b, &format!("r-{i}"), now);
        a.decline(&consent).unwrap();
    }
    assert!(matches!(
        a.request("media-1", &request(&b, "overflow"), now),
        Some(RequestResult::Reply(Signal::Deny {
            reason: DenialReason::Busy,
            ..
        }))
    ));
    pending(&mut a, &b, "fresh", now + Duration::from_secs(31));
}
fn binding() -> Binding {
    Binding {
        room_generation: "room-1".into(),
        peer_generation: "peer-1".into(),
        client_id: "client-1".into(),
        capture_session_id: "capture-1".into(),
        target: Target {
            source_id: "source-1".into(),
            media_id: "media-1".into(),
            geometry_revision: "layout-1".into(),
        },
    }
}
fn request(binding: &Binding, id: &str) -> Signal {
    Signal::Request {
        request_id: id.into(),
        target: binding.target.clone(),
    }
}
fn setup() -> (Authority<Fake>, Fake, Binding, Instant) {
    let fake = Fake::default();
    let b = binding();
    fake.current.borrow_mut().push(b.clone());
    let mut authority = Authority::new(fake.clone());
    assert!(authority.register(b.clone()));
    (authority, fake, b, Instant::now())
}
fn pending(authority: &mut Authority<Fake>, binding: &Binding, id: &str, now: Instant) -> String {
    match authority
        .request(&binding.target.media_id, &request(binding, id), now)
        .unwrap()
    {
        RequestResult::Pending { consent_id } => consent_id,
        result => panic!("Expected local consent, got {result:?}"),
    }
}
fn grant(authority: &mut Authority<Fake>, b: &Binding, now: Instant) -> String {
    let consent = pending(authority, b, "request-1", now);
    match authority.approve(&consent, now).unwrap() {
        Signal::Grant { grant_id, .. } => grant_id,
        _ => unreachable!(),
    }
}
#[test]
fn only_local_consent_opens_permission_and_all_binding_fields_must_match() {
    let (mut a, _, b, now) = setup();
    assert!(!a.permits(&b, "invented", now));
    let consent = pending(&mut a, &b, "request-1", now);
    assert!(!a.permits(&b, &consent, now));
    assert!(a.approve("request-1", now).is_none());
    let Signal::Grant { grant_id, .. } = a.approve(&consent, now).unwrap() else {
        unreachable!()
    };
    assert!(a.permits(&b, &grant_id, now));
    for i in 0..7 {
        let mut wrong = b.clone();
        match i {
            0 => wrong.room_generation.push('2'),
            1 => wrong.peer_generation.push('2'),
            2 => wrong.client_id.push('2'),
            3 => wrong.capture_session_id.push('2'),
            4 => wrong.target.source_id.push('2'),
            5 => wrong.target.media_id.push('2'),
            _ => wrong.target.geometry_revision.push('2'),
        }
        assert!(!a.permits(&wrong, &grant_id, now));
    }
}
#[test]
fn cancellation_timeout_and_replayed_requests_cannot_approve_an_old_dialog() {
    let (mut a, _, b, now) = setup();
    let old = pending(&mut a, &b, "r", now);
    assert_eq!(
        a.request("media-1", &request(&b, "r"), now),
        Some(RequestResult::Duplicate)
    );
    assert!(!a.receive_end(
        "other",
        &Signal::Cancel {
            request_id: "r".into()
        }
    ));
    assert!(a.receive_end(
        "media-1",
        &Signal::Cancel {
            request_id: "r".into()
        }
    ));
    assert!(a.approve(&old, now).is_none());
    let later = now + Duration::from_secs(31);
    let fresh = pending(&mut a, &b, "r", later);
    assert_ne!(old, fresh);
    assert!(a.approve(&old, later).is_none());
    assert!(a.approve(&fresh, later + Duration::from_secs(30)).is_none());
}
#[test]
fn one_controller_is_enforced_across_different_sources() {
    let (mut a, fake, b, now) = setup();
    let id = grant(&mut a, &b, now);
    let mut second = b.clone();
    second.client_id = "other".into();
    second.target.media_id = "media-2".into();
    second.target.source_id = "source-2".into();
    fake.current.borrow_mut().push(second.clone());
    assert!(a.register(second.clone()));
    assert!(matches!(
        a.request("media-2", &request(&second, "r2"), now),
        Some(RequestResult::Reply(Signal::Deny {
            reason: DenialReason::Busy,
            ..
        }))
    ));
    assert!(!a.receive_end(
        "media-2",
        &Signal::Revoke {
            grant_id: id.clone(),
            reason: RevocationReason::Ended
        }
    ));
    assert!(a.permits(&b, &id, now));
}
#[test]
fn geometry_capture_or_peer_change_revokes_before_the_next_permission_check() {
    let (mut a, fake, b, now) = setup();
    let id = grant(&mut a, &b, now);
    fake.current.borrow_mut().clear();
    assert!(!a.permits(&b, &id, now));
    assert_eq!(fake.released.borrow().len(), 1);
    fake.current.borrow_mut().push(b.clone());
    assert!(!a.renew(&b, &id, now));
    a.shutdown();
    assert_eq!(fake.released.borrow().len(), 1);
}
#[test]
fn input_timeout_preserves_consent_but_ended_grants_cannot_be_renewed() {
    let (mut a, fake, b, now) = setup();
    let id = grant(&mut a, &b, now);
    assert!(a.renew(&b, &id, now + Duration::from_millis(1000)));
    assert!(a.permits(&b, &id, now + Duration::from_millis(2999)));
    let later = now + Duration::from_secs(30);
    assert!(!a.permits(&b, &id, later));
    assert_eq!(a.grant().unwrap().id, id);
    assert_eq!(fake.released.borrow().len(), 1);
    a.tick(later);
    assert_eq!(fake.released.borrow().len(), 1);
    assert!(!a.renew(&b, "foreign-grant", later));
    assert!(a.renew(&b, &id, later));
    assert!(a.permits(&b, &id, later));
    a.revoke();
    assert!(!a.renew(&b, &id, later));
    assert_eq!(fake.released.borrow().len(), 2);
    drop(a);
    assert_eq!(fake.released.borrow().len(), 2);
}

#[test]
fn shutdown_is_terminal_and_rejects_late_owner_callbacks() {
    let (mut a, fake, b, now) = setup();
    let id = grant(&mut a, &b, now);
    a.shutdown();
    assert!(!a.register(b.clone()));
    assert!(a.request("media-1", &request(&b, "new"), now).is_none());
    assert!(!a.renew(&b, &id, now));
    assert_eq!(fake.released.borrow().len(), 1);
}
#[test]
fn disconnect_invalidates_pending_approval_and_old_disconnect_cannot_close_new_generation() {
    let (mut a, fake, b, now) = setup();
    let consent = pending(&mut a, &b, "old", now);
    a.invalidate(&b);
    let mut next = b.clone();
    next.room_generation = "room-2".into();
    next.peer_generation = "peer-2".into();
    fake.current.borrow_mut().push(next.clone());
    assert!(a.register(next.clone()));
    assert!(a.approve(&consent, now).is_none());
    let id = grant(&mut a, &next, now);
    a.invalidate(&b);
    assert!(a.permits(&next, &id, now));
    a.invalidate(&next);
    assert!(!a.permits(&next, &id, now));
}
#[test]
fn remote_grant_messages_and_unknown_sources_never_open_authority() {
    let (mut a, _, b, now) = setup();
    let forged = Signal::Grant {
        request_id: "r".into(),
        target: b.target.clone(),
        grant_id: "forged".into(),
        lease_ms: 2000,
    };
    assert!(a.request("media-1", &forged, now).is_none());
    assert!(!a.receive_end("media-1", &forged));
    assert!(!a.permits(&b, "forged", now));
    let mut wrong = b.clone();
    wrong.target.geometry_revision = "old".into();
    assert!(matches!(
        a.request("media-1", &request(&wrong, "r"), now),
        Some(RequestResult::Reply(Signal::Deny {
            reason: DenialReason::Unavailable,
            ..
        }))
    ));
}
#[test]
fn unavailable_target_cannot_be_approved_and_denial_prevents_late_consent() {
    let (mut a, fake, b, now) = setup();
    let consent = pending(&mut a, &b, "r", now);
    fake.current.borrow_mut().clear();
    assert!(a.approve(&consent, now).is_none());
    fake.current.borrow_mut().push(b.clone());
    let consent = pending(&mut a, &b, "r2", now);
    assert!(matches!(
        a.decline(&consent),
        Some(Signal::Deny {
            reason: DenialReason::Declined,
            ..
        })
    ));
    assert!(a.approve(&consent, now).is_none());
}
