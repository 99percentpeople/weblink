//! Native page lifetime is independent of foreground state and renderer timers.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone)]
pub(super) struct Page(Arc<AtomicBool>);
impl Default for Page {
    fn default() -> Self {
        Self(Arc::new(AtomicBool::new(true)))
    }
}
impl Page {
    pub(super) fn live(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}
impl Service {
    /// Fence the old page without waiting for native work on the window thread.
    /// Cleanup checks this fence under the authority lock, so a late callback
    /// cannot shut down a newly opened page's authority.
    pub fn close_page(self: &Arc<Self>) {
        {
            let mut page = self.page.lock().unwrap_or_else(|e| e.into_inner());
            page.0.store(false, Ordering::Release);
            *page = Page::default();
        }
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.expire());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn closing_the_page_fences_authority_without_waiting_for_native_work() {
        let (service, principal) = super::super::tests::fixture();
        let mut s = service.state.lock().unwrap();
        Service::token_grant(&mut s, &principal, &json!("local")).unwrap();
        let grant = s.grants.values().next().unwrap().id.clone();
        let (answer, mut result) = oneshot::channel();
        s.tickets.insert(
            "active".into(),
            Ticket {
                principal,
                call: Call {
                    name: "diagnostics.snapshot".into(),
                    source: None,
                    arguments: json!({"target":"local"}),
                },
                grant,
                deadline: Instant::now() + Duration::from_secs(60),
                answer,
                used: false,
            },
        );
        assert!(Service::check_call(&s, "epoch", "active").is_ok());
        // Simulate native work holding the authority lock when navigation arrives.
        service.close_page();
        assert!(!Service::current(&s));
        assert!(s.grants.values().all(|g| !Service::grant_live(&s, g)));
        assert_eq!(
            Service::check_call(&s, "epoch", "active"),
            Err("SESSION_CLOSED".into())
        );
        drop(s);
        service.expire();
        let s = service.state.lock().unwrap();
        assert!(!s.enabled);
        assert!(s.epoch.is_empty());
        assert!(s.grants.is_empty());
        assert!(s.tickets.is_empty());
        assert!(matches!(
            result.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
    }

    #[test]
    fn late_page_cleanup_cannot_close_the_replacement_session() {
        let (service, _) = super::super::tests::fixture();
        let queued_open = service.page.lock().unwrap().clone();
        let mut s = service.state.lock().unwrap();
        service.close_page();
        assert!(!queued_open.live(), "An old queued open must be rejected");
        service.shutdown_locked(&mut s);
        s.page = service.page.lock().unwrap().clone();
        s.epoch = "replacement".into();
        s.enabled = true;
        drop(s);
        service.expire();
        assert_eq!(service.close("epoch"), Err("SESSION_CLOSED".into()));
        let s = service.state.lock().unwrap();
        assert!(Service::check(&s, "replacement").is_ok());
        assert!(Service::current(&s));
    }

    #[test]
    fn a_closed_session_rejects_even_an_empty_epoch() {
        let service = Service::default();
        let s = service.state.lock().unwrap();
        assert_eq!(Service::check(&s, ""), Err("SESSION_CLOSED".into()));
        assert!(!Service::current(&s));
    }
}
