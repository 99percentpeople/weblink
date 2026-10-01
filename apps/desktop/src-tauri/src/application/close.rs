use super::Service;
use serde::{Deserialize, Serialize};
use tauri::{ipc::Channel, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    id: String,
    tray_available: bool,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Response {
    Cancel,
    Tray,
    Exit,
}

#[derive(Default)]
pub(super) struct Requests {
    listener: Option<(String, Channel<Request>)>,
    pending: Option<Request>,
}

impl Requests {
    fn watch(&mut self, id: String, events: Channel<Request>) {
        self.clear();
        self.listener = Some((id, events));
    }
    fn unwatch(&mut self, id: &str) {
        if self
            .listener
            .as_ref()
            .is_some_and(|(current, _)| current == id)
        {
            self.clear();
        }
    }
    pub(super) fn clear(&mut self) {
        self.listener = None;
        self.pending = None;
    }
    pub(super) fn pending(&self) -> bool {
        self.pending.is_some()
    }
    pub(super) fn request(&mut self, tray_available: bool) -> bool {
        if self.pending() {
            return true;
        }
        // Before the page is ready, or after its channel has ended, native close
        // must still work. Once subscribed, only a matching explicit reply acts.
        let Some((_, events)) = &self.listener else {
            return false;
        };
        let request = Request {
            id: uuid::Uuid::new_v4().to_string(),
            tray_available,
        };
        if events.send(request.clone()).is_err() {
            self.clear();
            return false;
        }
        self.pending = Some(request);
        true
    }
    fn validate(
        &self,
        owner: &str,
        request: &str,
        response: &Response,
        tray_ready: bool,
    ) -> Result<(), String> {
        if !self.listener.as_ref().is_some_and(|(id, _)| id == owner)
            || !self.pending.as_ref().is_some_and(|p| p.id == request)
        {
            return Err("Close request expired".into());
        }
        if *response == Response::Tray && !tray_ready {
            return Err("System tray unavailable".into());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn application_close_watch(
    service: State<'_, Service>,
    watch_id: String,
    events: Channel<Request>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&watch_id).map_err(|_| "Invalid close watcher")?;
    service
        .close
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .watch(watch_id, events);
    Ok(())
}

#[tauri::command]
pub fn application_close_unwatch(service: State<'_, Service>, watch_id: String) {
    service
        .close
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .unwatch(&watch_id);
}

#[tauri::command]
pub fn application_close_respond(
    window: tauri::WebviewWindow,
    service: State<'_, Service>,
    watch_id: String,
    request_id: String,
    response: Response,
    remember: bool,
) -> Result<(), String> {
    let mut requests = service.close.lock().unwrap_or_else(|e| e.into_inner());
    requests.validate(&watch_id, &request_id, &response, service.ready())?;
    if response == Response::Tray {
        super::hide(window.app_handle()).map_err(|e| e.to_string())?;
    }
    if remember && response != Response::Cancel {
        service
            .options
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .close_behavior = if response == Response::Tray {
            super::CloseBehavior::Tray
        } else {
            super::CloseBehavior::Exit
        };
    }
    requests.pending = None;
    drop(requests);
    if response == Response::Exit {
        window.app_handle().exit(0);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn channel() -> Channel<Request> {
        Channel::new(|_| Ok(()))
    }
    #[test]
    fn close_before_page_ready_is_allowed_and_repeated_requests_share_one_prompt() {
        let mut state = Requests::default();
        assert!(!state.request(true));
        state.watch("owner".into(), channel());
        assert!(state.request(true));
        let id = state.pending.as_ref().unwrap().id.clone();
        assert!(state.request(true));
        assert_eq!(state.pending.as_ref().unwrap().id, id);
        state.pending = None;
        assert!(state.request(true));
        assert_ne!(state.pending.as_ref().unwrap().id, id);
    }
    #[test]
    fn stale_page_cleanup_or_reply_cannot_affect_a_new_prompt() {
        let mut state = Requests::default();
        state.watch("old".into(), channel());
        state.request(true);
        let stale = state.pending.as_ref().unwrap().id.clone();
        state.watch("new".into(), channel());
        state.request(true);
        let current = state.pending.as_ref().unwrap().id.clone();
        state.unwatch("old");
        assert!(state
            .validate("old", &stale, &Response::Exit, true)
            .is_err());
        assert!(state
            .validate("new", &stale, &Response::Exit, true)
            .is_err());
        assert!(state
            .validate("new", &current, &Response::Cancel, true)
            .is_ok());
        assert!(state
            .validate("new", &current, &Response::Tray, false)
            .is_err());
        assert!(state.pending());
        state.unwatch("new");
        assert!(!state.pending());
        assert!(!state.request(true));
    }
    #[test]
    fn dead_channel_cannot_trap_window_close() {
        let mut state = Requests::default();
        state.watch(
            "owner".into(),
            Channel::new(|_| Err(tauri::Error::WindowNotFound)),
        );
        assert!(!state.request(true));
        assert!(!state.pending());
    }
}
