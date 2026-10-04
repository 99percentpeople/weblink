use super::{
    host::{Active, Host},
    input_error, Context, ControlEvent, Observer, Snapshot,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use weblink_desktop_capture::{media::control::Port, CaptureService};
use weblink_desktop_input::{
    authorization::Grant,
    protocol::{self, Signal},
    wire::Sequencer,
};
struct Owner {
    id: String,
    alive: AtomicBool,
    host: Mutex<Host>,
    thread: Mutex<Option<JoinHandle<()>>>,
    watch: Mutex<Option<StatusWatch>>,
}
struct StatusWatch {
    id: String,
    previous: Snapshot,
    send: Box<dyn Fn(Snapshot) -> bool + Send>,
}
impl Owner {
    // Called under the host lock, keeping snapshots and initial delivery ordered.
    fn publish(&self, status: Snapshot) {
        let mut slot = self.watch.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(watch) = slot.as_mut() {
            if watch.previous != status {
                watch.previous = status.clone();
                if !(watch.send)(status) {
                    *slot = None;
                }
            }
        }
    }
    fn live(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
    fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Some(t) = self.thread.lock().unwrap_or_else(|e| e.into_inner()).take() {
            t.thread().unpark();
            let _ = t.join();
        }
    }
}
#[derive(Default)]
pub struct Service {
    owner: Mutex<Option<Arc<Owner>>>,
    observer: Mutex<Option<Observer>>,
}
impl Service {
    pub fn observe(&self, observer: Observer) {
        *self.observer.lock().unwrap_or_else(|e| e.into_inner()) = Some(observer);
    }
    pub fn stop_capture(&self, session: &str) {
        let owner = self.owner.lock().unwrap_or_else(|e| e.into_inner()).clone();
        let Some(owner) = owner else {
            return;
        };
        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let ids: Vec<_> = host
            .peers
            .iter()
            .filter(|(_, peer)| peer.binding.capture_session_id == session)
            .map(|(id, _)| id.clone())
            .collect();
        for id in ids {
            host.remove_peer(&id);
        }
        owner.publish(host.snapshot());
    }
    fn owner(&self, id: &str) -> Result<Arc<Owner>, String> {
        self.owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .filter(|o| o.id == id && o.live())
            .cloned()
            .ok_or_else(|| "Remote control owner ended".into())
    }
    pub fn open(&self) -> Result<String, String> {
        self.start(weblink_desktop_input::session::start)
    }
    fn start(
        &self,
        start: impl FnOnce() -> Result<
            Box<dyn weblink_desktop_input::session::Session>,
            weblink_desktop_input::input::Error,
        >,
    ) -> Result<String, String> {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = slot.take() {
            old.shutdown();
        }
        let worker = start().map_err(input_error)?;
        let owner = Arc::new(Owner {
            id: uuid::Uuid::new_v4().to_string(),
            alive: AtomicBool::new(true),
            host: Mutex::new(Host {
                wake: None,
                worker,
                peers: HashMap::new(),
                pending: None,
                active: None,
                text_focus: Default::default(),
                observer: self
                    .observer
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .clone(),
            }),
            thread: Mutex::new(None),
            watch: Mutex::new(None),
        });
        let weak = Arc::downgrade(&owner);
        let thread = thread::Builder::new()
            .name("weblink-control".into())
            .spawn(move || {
                while let Some(owner) = weak.upgrade() {
                    if !owner.live() {
                        let mut h = owner.host.lock().unwrap_or_else(|e| e.into_inner());
                        for p in h.peers.values() {
                            p.endpoint.dispose();
                        }
                        h.worker.shutdown();
                        h.pending = None;
                        h.end_grant();
                        owner.publish(Snapshot {
                            closed: true,
                            ..Default::default()
                        });
                        owner.watch.lock().unwrap_or_else(|e| e.into_inner()).take();
                        break;
                    }
                    {
                        let mut host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
                        host.tick();
                        owner.publish(host.snapshot());
                    }
                    drop(owner);
                    // Channel arrivals wake this wait immediately. The timeout
                    // still services safety/liveness state without incoming input.
                    // unpark retains a token when arrival races with this park.
                    thread::park_timeout(Duration::from_millis(4));
                }
            })
            .map_err(|e| e.to_string())?;
        owner.host.lock().unwrap_or_else(|e| e.into_inner()).wake = Some(thread.thread().clone());
        *owner.thread.lock().unwrap_or_else(|e| e.into_inner()) = Some(thread);
        let id = owner.id.clone();
        *slot = Some(owner);
        Ok(id)
    }
    pub fn close(&self) {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(owner) = slot.take() {
            owner.shutdown();
        }
    }
    pub fn end(&self, id: &str) {
        let mut slot = self.owner.lock().unwrap_or_else(|e| e.into_inner());
        if slot.as_ref().is_some_and(|o| o.id == id) {
            if let Some(owner) = slot.take() {
                owner.shutdown();
            }
        }
    }
    pub fn status(&self, id: &str) -> Result<Snapshot, String> {
        // Polling only observes state. WebView scheduling must not own the lifetime
        // of an approved native session; room/media/window teardown owns it.
        let Ok(o) = self.owner(id) else {
            return Ok(Snapshot {
                closed: true,
                ..Default::default()
            });
        };
        let state = o.host.lock().unwrap_or_else(|e| e.into_inner()).snapshot();
        Ok(state)
    }
    pub fn watch(
        &self,
        id: &str,
        watch_id: String,
        send: impl Fn(Snapshot) -> bool + Send + 'static,
    ) -> Result<(), String> {
        let Ok(owner) = self.owner(id) else {
            return send(Snapshot {
                closed: true,
                ..Default::default()
            })
            .then_some(())
            .ok_or_else(|| "Control watcher closed".into());
        };
        let host = owner.host.lock().unwrap_or_else(|e| e.into_inner());
        let status = if owner.live() {
            host.snapshot()
        } else {
            Snapshot {
                closed: true,
                ..Default::default()
            }
        };
        if !send(status.clone()) {
            return Err("Control watcher closed".into());
        }
        if owner.live() {
            *owner.watch.lock().unwrap_or_else(|e| e.into_inner()) = Some(StatusWatch {
                id: watch_id,
                previous: status,
                send: Box::new(send),
            });
        }
        Ok(())
    }
    pub fn unwatch(&self, id: &str, watch_id: &str) {
        if let Ok(owner) = self.owner(id) {
            let mut slot = owner.watch.lock().unwrap_or_else(|e| e.into_inner());
            if slot.as_ref().is_some_and(|watch| watch.id == watch_id) {
                *slot = None;
            }
        }
    }
    pub fn revoke(&self, id: &str) -> Result<(), String> {
        let o = self.owner(id)?;
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        h.worker.revoke().map_err(input_error)?;
        h.pending = None;
        h.end_grant();
        o.publish(h.snapshot());
        Ok(())
    }
    /// Preserve the host's emergency path while the same app captures controller keys.
    pub fn emergency_revoke(&self) {
        let id = self
            .owner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|o| o.id.clone());
        if let Some(id) = id {
            let _ = self.revoke(&id);
        }
    }
    pub fn approve(&self, id: &str, consent: &str, approve: bool) -> Result<(), String> {
        let o = self.owner(id)?;
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        h.tick();
        let p = h
            .pending
            .as_ref()
            .filter(|p| p.view.consent_id == consent)
            .ok_or("Control request expired")?;
        let media = p.media.clone();
        let signal = if approve {
            h.worker.approve(consent.into())
        } else {
            h.worker.decline(consent.into())
        }
        .map_err(input_error)?
        .ok_or("Control request expired or input unavailable")?;
        h.worker.flush().map_err(input_error)?;
        h.pending = None;
        if let Signal::Grant { grant_id, .. } = &signal {
            let binding = h.peers.get(&media).ok_or("Media ended")?.binding.clone();
            h.active = Some(Active {
                sequencer: Sequencer::new(
                    grant_id.clone(),
                    media.clone(),
                    binding.target.geometry_revision.clone(),
                ),
                grant: Grant {
                    id: grant_id.clone(),
                    binding,
                },
            });
        }
        if !h
            .peers
            .get(&media)
            .is_some_and(|p| p.endpoint.send(&signal))
        {
            let _ = h.worker.revoke();
            h.end_grant();
            return Err("Control channel ended".into());
        }
        if let (Some(observer), Signal::Grant { grant_id, .. }) = (&h.observer, &signal) {
            observer(ControlEvent::Granted(grant_id.clone()));
        }
        o.publish(h.snapshot());
        Ok(())
    }
    pub fn attach(
        &self,
        capture: Arc<CaptureService>,
        context: Context,
        session: String,
        media: String,
    ) -> Result<Arc<dyn Port>, String> {
        let o = self.owner(&context.owner_id)?;
        if ![
            &context.peer_generation,
            &context.client_id,
            &context.source_id,
            &media,
        ]
        .into_iter()
        .all(|s| protocol::valid_id(s))
        {
            return Err("Invalid local control binding".into());
        }
        let target = super::binding::resolve(&capture, &o.id, context, session, media)?;
        let mut h = o.host.lock().unwrap_or_else(|e| e.into_inner());
        h.register(capture, target)
            .map(|endpoint| endpoint as Arc<dyn Port>)
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(all(test, windows))]
#[allow(dead_code)]
#[path = "../../../../../crates/desktop-input/examples/support/mod.rs"]
mod test_window;
#[cfg(test)]
mod tests;
#[cfg(all(test, windows))]
mod windows_tests;
