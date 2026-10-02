use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;
mod backend;
mod image;
#[cfg(any(windows, test))]
mod xml;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ActionButton {
    pub id: String,
    pub title: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reply {
    pub title: String,
    pub placeholder: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub body: String,
    pub icon: Option<String>,
    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub silent: bool,
    pub expires_at: u64,
    #[serde(default)]
    pub actions: Vec<ActionButton>,
    pub reply: Option<Reply>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub action: String,
    pub text: Option<String>,
}
#[derive(Serialize)]
pub struct Capabilities {
    permission: &'static str,
    actions: bool,
    reply: bool,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl Notification {
    fn validate(&self) -> Result<(), String> {
        if self.id.is_empty()
            || self.id.len() > 256
            || self.title.len() > 1024
            || self.body.len() > 8192
            || self.expires_at <= now()
            || self.expires_at > now() + 24 * 60 * 60 * 1000
            || self.actions.len() > 2
            || self
                .actions
                .iter()
                .any(|a| !matches!(a.id.as_str(), "approve" | "decline") || a.title.len() > 256)
            || self
                .reply
                .as_ref()
                .is_some_and(|r| r.title.len() > 256 || r.placeholder.len() > 256)
        {
            return Err("Invalid notification".into());
        }
        Ok(())
    }
    #[cfg(any(windows, test))]
    fn accepts(&self, action: &Action) -> bool {
        self.id == action.id
            && self.expires_at > now()
            && (action.action == "open"
                || self.actions.iter().any(|a| a.id == action.action)
                || (action.action == "reply"
                    && self.reply.is_some()
                    && action
                        .text
                        .as_ref()
                        .is_some_and(|t| !t.trim().is_empty() && t.len() <= 16384)))
    }
}
struct Entry {
    notification: Notification,
    _native: backend::Notice,
    // Drop after the OS notification, which may still be reading the file.
    _icon: Option<image::Icon>,
}
struct Watch {
    id: String,
    _events: Channel<Action>,
    entries: HashMap<String, Entry>,
}
#[derive(Default)]
pub struct Service(Mutex<Option<Watch>>);
impl Service {
    pub fn clear(&self) {
        let old = self.0.lock().unwrap().take();
        drop(old);
    }
    #[cfg(windows)]
    fn dispatch(&self, app: &tauri::AppHandle, watch_id: &str, action: Action) {
        let removed = {
            let mut state = self.0.lock().unwrap();
            let Some(watch) = state.as_mut().filter(|w| w.id == watch_id) else {
                return;
            };
            if !watch
                .entries
                .get(&action.id)
                .is_some_and(|e| e.notification.accepts(&action))
            {
                return;
            }
            let entry = watch.entries.remove(&action.id);
            if action.action == "open" {
                crate::application::show(app);
            }
            let _ = watch._events.send(action);
            entry
        };
        drop(removed);
    }
}
#[tauri::command]
pub fn notifications_capabilities(app: tauri::AppHandle) -> Result<Capabilities, String> {
    backend::capabilities(&app)
}
#[tauri::command]
pub fn notifications_request_permission(app: tauri::AppHandle) -> Result<&'static str, String> {
    backend::permission(&app)
}
#[tauri::command]
pub fn notifications_watch(
    service: tauri::State<'_, Service>,
    watch_id: String,
    events: Channel<Action>,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(&watch_id).is_err() {
        return Err("Invalid watcher".into());
    }
    let old = service.0.lock().unwrap().replace(Watch {
        id: watch_id,
        _events: events,
        entries: HashMap::new(),
    });
    drop(old);
    Ok(())
}
#[tauri::command]
pub fn notifications_unwatch(service: tauri::State<'_, Service>, watch_id: String) {
    let old = {
        let mut state = service.0.lock().unwrap();
        if state.as_ref().is_some_and(|w| w.id == watch_id) {
            state.take()
        } else {
            None
        }
    };
    drop(old);
}
#[tauri::command]
pub fn notifications_show(
    app: tauri::AppHandle,
    service: tauri::State<'_, Service>,
    watch_id: String,
    notification: Notification,
) -> Result<(), String> {
    notification.validate()?;
    let mut state = service.0.lock().unwrap();
    let watch = state
        .as_mut()
        .filter(|w| w.id == watch_id)
        .ok_or("Notification watcher ended")?;
    watch
        .entries
        .retain(|_, entry| entry.notification.expires_at > now());
    if watch.entries.contains_key(&notification.id) {
        return Ok(());
    }
    if watch.entries.len() >= 64 {
        return Err("Too many notifications".into());
    }
    // Invalid/unavailable avatars degrade to a text notification.
    let icon = notification
        .icon
        .as_deref()
        .and_then(|data| image::Icon::new(data).ok());
    let native = backend::show(&app, &watch_id, &notification, icon.as_ref())?;
    watch.entries.insert(
        notification.id.clone(),
        Entry {
            notification,
            _native: native,
            _icon: icon,
        },
    );
    Ok(())
}
#[tauri::command]
pub fn notifications_dismiss(service: tauri::State<'_, Service>, watch_id: String, id: String) {
    let removed = service
        .0
        .lock()
        .unwrap()
        .as_mut()
        .filter(|w| w.id == watch_id)
        .and_then(|w| w.entries.remove(&id));
    drop(removed);
}

#[cfg(test)]
mod tests {
    use super::*;
    pub fn notice() -> Notification {
        Notification {
            id: "test".into(),
            title: "Title".into(),
            body: "Body".into(),
            icon: None,
            silent: true,
            expires_at: now() + 60000,
            actions: vec![ActionButton {
                id: "approve".into(),
                title: "Allow".into(),
            }],
            reply: None,
        }
    }
    #[test]
    fn actions_are_scoped_and_expire() {
        let mut n = notice();
        let mut a = Action {
            id: n.id.clone(),
            action: "approve".into(),
            text: None,
        };
        assert!(n.accepts(&a));
        a.id = "other".into();
        assert!(!n.accepts(&a));
        a.id = n.id.clone();
        a.action = "reply".into();
        a.text = Some("hello".into());
        assert!(!n.accepts(&a));
        n.reply = Some(Reply {
            title: "Reply".into(),
            placeholder: "".into(),
        });
        assert!(n.accepts(&a));
        n.expires_at = 0;
        assert!(!n.accepts(&a));
        assert!(n.validate().is_err());
    }
}
