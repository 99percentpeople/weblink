//! Presentation observation only; never changes a capture or remote-control owner.
use std::collections::HashMap;
use tauri::{ipc::Channel, Manager, WebviewWindow};

struct Watch {
    previous: bool,
    events: Channel<bool>,
}

#[derive(Default)]
pub(super) struct Watches(HashMap<String, Watch>);
impl Watches {
    fn watch(&mut self, id: String, visible: bool, events: Channel<bool>) -> Result<(), String> {
        if self.0.contains_key(&id) || self.0.len() >= 32 {
            return Err("Visibility watcher already exists or limit reached".into());
        }
        events.send(visible).map_err(|e| e.to_string())?;
        self.0.insert(
            id,
            Watch {
                previous: visible,
                events,
            },
        );
        Ok(())
    }
    fn update(&mut self, visible: bool) {
        self.0.retain(|_, watch| {
            if watch.previous == visible {
                return true;
            }
            watch.previous = visible;
            watch.events.send(visible).is_ok()
        });
    }
    pub fn clear(&mut self) {
        self.0.clear();
    }
}

fn visible(window: &WebviewWindow) -> bool {
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(true)
}

pub fn update(window: &WebviewWindow) {
    let current = window.clone();
    let _ = window.run_on_main_thread(move || {
        // Read at delivery time, never replay visibility captured before a queued hide/show.
        let visible = visible(&current);
        current
            .state::<super::Service>()
            .visibility
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .update(visible);
        crate::preview::update_visibility(&current);
    });
}

#[tauri::command]
pub async fn application_visibility_watch(
    window: WebviewWindow,
    watch_id: String,
    events: Channel<bool>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&watch_id).map_err(|_| "Invalid visibility watcher")?;
    let (send, mut receive) = tauri::async_runtime::channel(1);
    let current = window.clone();
    window
        .run_on_main_thread(move || {
            let visible = visible(&current);
            let result = current
                .state::<super::Service>()
                .visibility
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .watch(watch_id.clone(), visible, events);
            if send.try_send(result).is_err() {
                current
                    .state::<super::Service>()
                    .visibility
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .0
                    .remove(&watch_id);
            }
        })
        .map_err(|e| e.to_string())?;
    receive.recv().await.ok_or("Visibility window closed")?
}

#[tauri::command]
pub fn application_visibility_unwatch(service: tauri::State<'_, super::Service>, watch_id: String) {
    service
        .visibility
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .0
        .remove(&watch_id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[test]
    fn initial_changes_and_cleanup_are_scoped_to_each_subscription() {
        let mut watches = Watches::default();
        let values = Arc::new(Mutex::new(Vec::new()));
        let output = values.clone();
        watches
            .watch(
                "first".into(),
                false,
                Channel::new(move |body| {
                    output.lock().unwrap().push(body);
                    Ok(())
                }),
            )
            .unwrap();
        watches.update(false);
        watches.update(true);
        assert_eq!(values.lock().unwrap().len(), 2);
        watches
            .watch("second".into(), true, Channel::new(|_| Ok(())))
            .unwrap();
        watches.0.remove("first");
        watches.update(false);
        assert_eq!(values.lock().unwrap().len(), 2);
        assert!(watches.0.contains_key("second"));
        watches.clear();
        assert!(watches.0.is_empty());
    }

    #[test]
    fn failed_channels_are_released() {
        let mut watches = Watches::default();
        let dead = || Channel::new(|_| Err(tauri::Error::WindowNotFound));
        assert!(watches.watch("dead".into(), true, dead()).is_err());
        watches.0.insert(
            "later".into(),
            Watch {
                previous: true,
                events: dead(),
            },
        );
        watches.update(false);
        assert!(watches.0.is_empty());
    }
}
