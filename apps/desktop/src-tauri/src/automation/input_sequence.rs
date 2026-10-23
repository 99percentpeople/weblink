//! One FIFO for native automation input. Permission locks are never held while queued.
use super::*;
use tauri::Manager;
use tokio::sync::{Mutex as AsyncMutex, OwnedMutexGuard};
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
    _guard: OwnedMutexGuard<()>,
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
    let window_bound = lease
        .as_ref()
        .map(|lease| control.automation_window_bound(&principal, lease))
        .transpose()?;
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
            if let (Some(lease), Some(expected)) = (&lease, window_bound) {
                if control.automation_window_bound(&principal, lease)? != expected {
                    return Err("WINDOW_BINDING_CHANGED".into());
                }
            }
            Ok(())
        })
        .await?;
    Ok(Turn {
        principal,
        lease,
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
