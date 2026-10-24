//! One FIFO for native automation input. Permission locks are never held while queued.
use super::*;
use tauri::Manager;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
use weblink_desktop_input::{input::Error, window::BoundWindow};
#[derive(Default)]
pub(super) struct Queue(Arc<AsyncMutex<()>>);
impl Queue {
    pub async fn enter(
        &self,
        check: impl Fn() -> Result<(), String>,
    ) -> Result<OwnedMutexGuard<()>, String> {
        let waiting = self.0.clone().lock_owned();
        tokio::pin!(waiting);
        loop {
            check()?;
            tokio::select! {
                turn = &mut waiting => { check()?; return Ok(turn); },
                _ = tokio::time::sleep(Duration::from_millis(16)) => {},
            }
        }
    }
}
pub(super) struct Turn {
    pub lease: Option<String>,
    pub principal: String,
    pub window: Option<BoundWindow>,
    _guard: OwnedMutexGuard<()>,
}
/// Lease cleanup can erase the native focus error before an in-flight call
/// observes it. Report loss of the original window's focus without inferring
/// whether the operation succeeded or the window closed.
pub(super) fn window_result<T>(
    result: Result<T, String>,
    window: Option<&BoundWindow>,
    authorized: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    result.map_err(|error| {
        let Some(window) = window else { return error };
        if !matches!(
            error.as_str(),
            "CONTROL_REQUIRED" | "WINDOW_UNAVAILABLE" | "WINDOW_FOCUS_LOST"
        ) {
            return error;
        }
        if let Err(error) = authorized() {
            return error;
        }
        if error != "CONTROL_REQUIRED"
            || matches!(
                window.check(None),
                Err(Error::WindowFocusLost | Error::WindowUnavailable)
            )
        {
            "WINDOW_FOCUS_LOST".into()
        } else {
            error
        }
    })
}
pub(super) fn check<'a>(s: &'a State, epoch: &str, id: &str) -> Result<&'a Ticket, String> {
    Service::check(s, epoch)?;
    let t = s.tickets.get(id).ok_or("CANCELLED")?;
    if t.deadline <= Instant::now()
        || !Service::current(s)
        || !Service::call_enabled(s, &t.principal, &t.call)
        || t.call.arguments["target"] != "local"
        || !s.grants.get(&t.grant).is_some_and(|g| {
            Service::grant_live(s, g)
                && g.principal.id == t.principal.id
                && g.target == "local"
                && g.scopes.iter().any(|v| v == "input.control")
        })
    {
        return Err("GRANT_EXPIRED".into());
    }
    if !s.pending.is_empty() {
        return Err("APPROVAL_PENDING".into());
    }
    Ok(t)
}
pub async fn enter(
    app: &tauri::AppHandle,
    service: &Shared,
    epoch: &str,
    id: &str,
) -> Result<Turn, String> {
    let control = app.state::<crate::remote_control::Shared>();
    let (principal, lease) = {
        let s = service.state.lock().unwrap();
        let t = check(&s, epoch, id)?;
        if t.used {
            return Err("CANCELLED".into());
        }
        let lease = if t.call.name == "control.acquire" {
            None
        } else {
            Some(control.automation_lease(&t.principal.id)?)
        };
        (t.principal.id.clone(), lease)
    };
    let window = lease
        .as_ref()
        .map(|lease| control.automation_bound_window(&principal, lease))
        .transpose()?
        .flatten();
    let guard = service
        .input_queue
        .enter(|| {
            let s = service.state.lock().unwrap();
            let t = check(&s, epoch, id)?;
            if t.used || t.principal.id != principal {
                return Err("CANCELLED".into());
            }
            if lease
                .as_ref()
                .is_some_and(|lease| !control.automation_matches(&principal, lease))
            {
                return Err("CONTROL_REQUIRED".into());
            }
            if let Some(lease) = &lease {
                if control.automation_window_bound(&principal, lease)? != window.is_some() {
                    return Err("WINDOW_BINDING_CHANGED".into());
                }
            }
            Ok(())
        })
        .await;
    let guard = window_result(guard, window.as_ref(), || {
        check(&service.state.lock().unwrap(), epoch, id).map(|_| ())
    })?;
    Ok(Turn {
        principal,
        lease,
        window,
        _guard: guard,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::Future,
        pin::Pin,
        sync::atomic::{AtomicBool, Ordering},
        task::Poll,
    };
    struct Window(Result<(), Error>);
    impl weblink_desktop_input::window::WindowGuard for Window {
        fn check(&self, _: Option<(i32, i32)>) -> Result<(), Error> {
            self.0
        }
        fn activate(&self) -> Result<(), Error> {
            panic!("Error reporting must never reactivate the window")
        }
    }
    #[test]
    fn bound_window_errors_report_focus_loss_without_claiming_success() {
        for state in [Err(Error::WindowFocusLost), Err(Error::WindowUnavailable)] {
            let window: BoundWindow = Arc::new(Window(state));
            for error in [
                "CONTROL_REQUIRED",
                "WINDOW_UNAVAILABLE",
                "WINDOW_FOCUS_LOST",
            ] {
                assert_eq!(
                    window_result::<()>(Err(error.into()), Some(&window), || Ok(())),
                    Err("WINDOW_FOCUS_LOST".into())
                );
            }
            // A completed operation stays completed, even if focus later changes.
            assert_eq!(window_result(Ok(3), Some(&window), || panic!()), Ok(3));
        }
    }
    #[test]
    fn focus_reporting_preserves_other_failures_and_authority_checks() {
        let window: BoundWindow = Arc::new(Window(Err(Error::WindowUnavailable)));
        for error in [
            "CANCELLED",
            "GRANT_EXPIRED",
            "APPROVAL_PENDING",
            "INJECTION_FAILED",
            "HOLD_EXPIRED",
            "OUTSIDE_BOUND_WINDOW",
        ] {
            assert_eq!(
                window_result::<()>(Err(error.into()), Some(&window), || panic!()),
                Err(error.into())
            );
        }
        for error in ["CANCELLED", "GRANT_EXPIRED", "APPROVAL_PENDING"] {
            assert_eq!(
                window_result::<()>(Err("CONTROL_REQUIRED".into()), Some(&window), || Err(
                    error.into()
                )),
                Err(error.into())
            );
        }
        assert_eq!(
            window_result::<()>(Err("CONTROL_REQUIRED".into()), None, || panic!()),
            Err("CONTROL_REQUIRED".into())
        );
        let focused: BoundWindow = Arc::new(Window(Ok(())));
        assert_eq!(
            window_result::<()>(Err("CONTROL_REQUIRED".into()), Some(&focused), || Ok(())),
            Err("CONTROL_REQUIRED".into())
        );
    }
    #[test]
    fn focus_error_survives_native_lease_cleanup_for_owned_and_borrowed_input() {
        use crate::remote_control::{with_bound_borrowed_input, with_bound_owned_input};
        let verify =
            |control: &crate::remote_control::Service, lease: &str, focus: &dyn Fn(bool)| {
                let window = control
                    .automation_bound_window("client", lease)
                    .unwrap()
                    .unwrap();
                assert!(control.automation_bound_window("other", lease).is_err());
                assert!(control.automation_bound_window("client", "old").is_err());
                focus(false);
                // Simulate the sampler/runner finishing lease cleanup before the
                // invocation's final check. The retained guard still describes it.
                control.automation_revoke_lease("client", lease);
                let result = control.automation_input("client", lease, vec![]);
                assert_eq!(result, Err("CONTROL_REQUIRED".into()));
                assert_eq!(
                    window_result(result, Some(&window), || Ok(())),
                    Err("WINDOW_FOCUS_LOST".into())
                );
                focus(true);
                assert!(!control.automation_matches("client", lease));
            };
        with_bound_owned_input(verify);
        with_bound_borrowed_input(verify);
    }
    async fn queued<F: Future>(mut future: Pin<&mut F>) {
        std::future::poll_fn(|cx| {
            assert!(future.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await
    }
    #[tokio::test]
    async fn fifo_turns_never_overlap_and_cancelled_waiters_do_not_release_active_work() {
        let queue = Queue::default();
        let first = queue.enter(|| Ok(())).await.unwrap();
        let live = AtomicBool::new(true);
        let cancelled = queue.enter(|| {
            if live.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("CANCELLED".into())
            }
        });
        tokio::pin!(cancelled);
        queued(cancelled.as_mut()).await;
        let second = queue.enter(|| Ok(()));
        tokio::pin!(second);
        queued(second.as_mut()).await;
        let third = queue.enter(|| Ok(()));
        tokio::pin!(third);
        queued(third.as_mut()).await;
        live.store(false, Ordering::SeqCst);
        assert_eq!(cancelled.await.unwrap_err(), "CANCELLED");
        assert!(queue.0.try_lock().is_err());
        drop(first);
        let second = second.await.unwrap();
        queued(third.as_mut()).await;
        drop(second);
        let _third = third.await.unwrap();
    }
    #[tokio::test]
    async fn queued_work_rechecks_control_generation_before_it_can_execute() {
        let queue = Queue::default();
        let first = queue.enter(|| Ok(())).await.unwrap();
        let same = AtomicBool::new(true);
        let next = queue.enter(|| {
            if same.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err("CONTROL_REQUIRED".into())
            }
        });
        tokio::pin!(next);
        queued(next.as_mut()).await;
        same.store(false, Ordering::SeqCst);
        drop(first);
        assert_eq!(next.await.unwrap_err(), "CONTROL_REQUIRED");
        assert!(queue.enter(|| Ok(())).await.is_ok());
    }
    #[test]
    fn ticket_checks_cover_cancellation_expiry_review_and_exact_authority() {
        let p = Principal {
            id: "peer".into(),
            label: "Peer".into(),
            kind: "peer".into(),
            generation: None,
        };
        let mut s = State {
            epoch: "epoch".into(),
            enabled: true,
            mcp_enabled: true,
            ..Default::default()
        };
        s.peers.insert(p.id.clone(), p.clone());
        s.grants.insert(
            "grant".into(),
            Grant {
                id: "grant".into(),
                target: "local".into(),
                principal: p.clone(),
                scopes: vec!["input.control".into()],
                expires_at: Some(now() + 60000),
                source: GrantSource::Consent,
            },
        );
        s.tickets.insert(
            "call".into(),
            Ticket {
                principal: p.clone(),
                call: Call {
                    source: None,
                    name: "control.pointer".into(),
                    arguments: json!({"target":"local"}),
                },
                grant: "grant".into(),
                deadline: Instant::now() + Duration::from_secs(10),
                answer: oneshot::channel().0,
                used: false,
            },
        );
        assert!(check(&s, "epoch", "call").is_ok());
        s.pending.insert(
            "review".into(),
            Pending {
                principal: p,
                call: s.tickets["call"].call.clone(),
                scope: "input.control".into(),
                deadline: Instant::now() + Duration::from_secs(30),
                answer: oneshot::channel().0,
            },
        );
        assert!(matches!(check(&s,"epoch","call"),Err(e) if e=="APPROVAL_PENDING"));
        s.pending.clear();
        s.grants.get_mut("grant").unwrap().expires_at = Some(now() - 1);
        assert!(check(&s, "epoch", "call").is_err());
        s.grants.get_mut("grant").unwrap().expires_at = Some(now() + 60000);
        s.grants.get_mut("grant").unwrap().scopes = vec!["screen.read".into()];
        assert!(check(&s, "epoch", "call").is_err());
        s.grants.get_mut("grant").unwrap().scopes = vec!["input.control".into()];
        s.grants.get_mut("grant").unwrap().principal.id = "other".into();
        assert!(check(&s, "epoch", "call").is_err());
        s.tickets.clear();
        assert!(matches!(check(&s,"epoch","call"),Err(e) if e=="CANCELLED"));
    }
}
