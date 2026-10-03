//! Compact presentation reuses the main window and its renderer/media owners.
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{ipc::Channel, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};
mod motion;
use motion::{Finish, Transition};

#[derive(Clone, Copy, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    eligible: bool,
    automatic: bool,
    #[serde(default)]
    reduced_motion: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    active: bool,
    transitioning: bool,
    revision: u64,
    title_bar_height: f64,
}

/// Physical outer bounds, including the OS title bar and resize borders.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Bounds {
    size: PhysicalSize<u32>,
    position: PhysicalPosition<i32>,
}
impl Bounds {
    fn read(window: &WebviewWindow) -> tauri::Result<Self> {
        Ok(Self {
            size: window.outer_size()?,
            position: window.outer_position()?,
        })
    }
}

#[derive(Clone, Copy)]
struct FrameInsets {
    width: u32,
    height: u32,
    top: i32,
}
impl FrameInsets {
    fn read(window: &WebviewWindow) -> tauri::Result<Self> {
        let outer = Bounds::read(window)?;
        let inner = window.inner_size()?;
        Ok(Self {
            width: outer.size.width.saturating_sub(inner.width),
            height: outer.size.height.saturating_sub(inner.height),
            top: window
                .inner_position()
                .map(|p| p.y.saturating_sub(outer.position.y).max(0))
                .unwrap_or(0),
        })
    }
    fn outer_size(self, client: PhysicalSize<u32>) -> PhysicalSize<u32> {
        PhysicalSize::new(
            client.width.saturating_add(self.width),
            client.height.saturating_add(self.height),
        )
    }
    #[cfg(any(not(windows), test))]
    fn client_size(self, outer: PhysicalSize<u32>) -> PhysicalSize<u32> {
        PhysicalSize::new(
            outer.width.saturating_sub(self.width).max(1),
            outer.height.saturating_sub(self.height).max(1),
        )
    }
    fn title_bar_height(self, frameless: Self, scale: f64) -> f64 {
        let caption = self.top.saturating_sub(frameless.top).max(0) as f64 / scale;
        if caption > 0.0 {
            caption
        } else {
            36.0
        }
    }
}

struct Snapshot {
    bounds: Bounds,
    presented: Bounds,
    maximized: bool,
    decorated: bool,
    topmost: bool,
    resizable: bool,
    maximizable: bool,
}

#[derive(Default)]
struct State {
    watcher: Option<(String, Channel<Status>)>,
    options: Options,
    normal: Option<Bounds>,
    snapshot: Option<Snapshot>,
    suspended: bool,
    armed: bool,
    background_revision: u64,
    revision: u64,
    motion_id: u64,
    motion: Option<Transition>,
    waiters: Vec<tauri::async_runtime::Sender<Result<Status, String>>>,
    title_bar_height: Option<f64>,
}

impl State {
    fn configure(&mut self, options: Options, focused: bool) {
        // Leaving/restoring disarms background entry. Rejoining while the window
        // stays focused must rearm it without requiring an extra focus round trip.
        if options.eligible
            && options.automatic
            && (!self.options.eligible || !self.options.automatic)
            && self.snapshot.is_none()
            && !self.suspended
            && focused
        {
            self.armed = true;
        }
        self.options = options;
    }
    fn owns(&self, id: &str) -> Result<(), String> {
        if self.watcher.as_ref().is_some_and(|(owner, _)| owner == id) {
            Ok(())
        } else {
            Err("Picture-in-picture session expired".into())
        }
    }
    fn status(&self) -> Status {
        Status {
            active: self.snapshot.is_some() && !self.suspended,
            transitioning: self.motion.is_some(),
            revision: self.revision,
            title_bar_height: self.title_bar_height.unwrap_or(36.0),
        }
    }
    fn notify(&self) {
        if let Some((_, events)) = &self.watcher {
            let _ = events.send(self.status());
        }
    }
    fn changed(&mut self) {
        self.revision = self.revision.wrapping_add(1);
        self.notify();
    }
    fn settle(&mut self, result: Result<(), String>) {
        let result = result.map(|()| self.status());
        for waiter in self.waiters.drain(..) {
            let _ = waiter.try_send(result.clone());
        }
    }
    fn suspend(&mut self) {
        // Keep the native rectangle and frame untouched throughout hiding.
        // The original snapshot is restored only when the window is shown again.
        self.suspended = true;
        self.motion = None;
        self.armed = false;
        self.background_revision = self.background_revision.wrapping_add(1);
        self.changed();
        self.settle(Ok(()));
    }
    fn begin_motion(&mut self, window: &WebviewWindow, from: Bounds, to: Bounds, finish: Finish) {
        self.motion_id = self.motion_id.wrapping_add(1);
        self.motion = Some(Transition::new(self.motion_id, from, to, finish));
        self.changed();
        motion::drive(window.clone(), self.motion_id);
    }
    fn advance(&mut self, window: &WebviewWindow, id: u64) -> bool {
        let Some(transition) = self.motion.as_ref().filter(|m| m.id == id) else {
            return false;
        };
        let (bounds, done) = transition.frame();
        if let Err(error) = motion::apply(window, bounds) {
            eprintln!("could not animate picture-in-picture: {error}");
            // Resolve the command as a failure even if rollback succeeds.
            let waiters = std::mem::take(&mut self.waiters);
            let rollback = self.restore(window, false);
            self.waiters = waiters;
            self.settle(Err(rollback
                .err()
                .map_or(error.clone(), |restore| format!("{error}; {restore}"))));
            return false;
        }
        if done {
            let transition = self.motion.take().unwrap();
            match transition.finish {
                Finish::Enter => {
                    self.changed();
                    self.settle(Ok(()));
                }
                Finish::Restore { focus } => {
                    let _ = self.restore(window, focus);
                }
            }
        }
        !done
    }
    fn observe(&mut self, window: &WebviewWindow) {
        if self.snapshot.is_none()
            && window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
            && !window.is_maximized().unwrap_or(true)
            && !window.is_fullscreen().unwrap_or(true)
        {
            if let Ok(bounds) = Bounds::read(window) {
                if bounds.size.width > 0 && bounds.size.height > 0 {
                    self.normal = Some(bounds);
                }
            }
        }
    }
    fn enter(&mut self, window: &WebviewWindow, automatic: bool) -> Result<(), String> {
        if self.suspended {
            return Err("Window is hidden".into());
        }
        if self.snapshot.is_some() {
            return Ok(());
        }
        if !self.options.eligible || self.watcher.is_none() {
            return Err("No meeting view is available for picture-in-picture".into());
        }
        if window.is_fullscreen().map_err(|e| e.to_string())? {
            return Err("Leave fullscreen before entering picture-in-picture".into());
        }
        self.observe(window);
        let presented = Bounds::read(window).map_err(|e| e.to_string())?;
        let minimized = window.is_minimized().map_err(|e| e.to_string())?;
        let animate = !self.options.reduced_motion && !minimized;
        let bounds = self.normal.unwrap_or(presented);
        self.snapshot = Some(Snapshot {
            bounds,
            presented: if minimized { bounds } else { presented },
            maximized: window.is_maximized().map_err(|e| e.to_string())?,
            decorated: window.is_decorated().map_err(|e| e.to_string())?,
            topmost: window.is_always_on_top().map_err(|e| e.to_string())?,
            resizable: window.is_resizable().map_err(|e| e.to_string())?,
            maximizable: window.is_maximizable().map_err(|e| e.to_string())?,
        });
        let result = (|| -> tauri::Result<(Bounds, Bounds)> {
            // Automatic entry must not steal focus from the newly active app.
            if automatic {
                window.set_focusable(false)?;
            }
            window.unmaximize()?;
            window.unminimize()?;
            let original_frame = FrameInsets::read(window)?;
            window.set_decorations(false)?;
            window.set_always_on_top(true)?;
            window.set_resizable(true)?;
            window.set_maximizable(false)?;
            window.set_min_size(Some(LogicalSize::new(280.0, 180.0)))?;
            let frame = FrameInsets::read(window)?;
            let scale = window.scale_factor()?;
            let title_bar_height = original_frame.title_bar_height(frame, scale);
            self.title_bar_height = Some(title_bar_height);
            // Preserve the visible outer rectangle while the native title bar
            // is exchanged for the measured title bar inside the WebView.
            let from = if minimized { bounds } else { presented };
            let size = frame
                .outer_size(LogicalSize::new(480.0, 350.0 + title_bar_height).to_physical(scale));
            let mut target = Bounds {
                size,
                position: from.position,
            };
            if let Some(monitor) = window.current_monitor()? {
                let work = monitor.work_area();
                let margin = (16.0 * monitor.scale_factor()) as i32;
                target.position = corner(work.position, work.size, size, margin);
            }
            window.show()?;
            Ok((from, target))
        })();
        let focusable = window.set_focusable(true).map_err(|e| e.to_string());
        let result = result
            .map_err(|e| e.to_string())
            .and_then(|bounds| focusable.map(|()| bounds));
        let outcome = result.and_then(|(from, target)| {
            if animate {
                motion::apply(window, from)?;
                self.begin_motion(window, from, target, Finish::Enter);
            } else {
                motion::apply(window, target)?;
                self.changed();
            }
            Ok(())
        });
        if let Err(error) = outcome {
            let rollback = self.restore(window, false);
            return Err(rollback.err().map_or(error.clone(), |restore| {
                format!("{error}; restore failed: {restore}")
            }));
        }
        Ok(())
    }
    fn leave(&mut self, window: &WebviewWindow, focus: bool) -> Result<(), String> {
        let Some(snapshot) = self.snapshot.as_ref() else {
            return Ok(());
        };
        if self
            .motion
            .as_ref()
            .is_some_and(|m| matches!(m.finish, Finish::Restore { .. }))
        {
            return Ok(());
        }
        if self.options.reduced_motion
            || !window.is_visible().unwrap_or(false)
            || window.is_minimized().unwrap_or(true)
        {
            return self.restore(window, focus);
        }
        let to = if snapshot.maximized {
            snapshot.presented
        } else {
            snapshot.bounds
        };
        let from = Bounds::read(window).map_err(|e| e.to_string())?;
        self.begin_motion(window, from, to, Finish::Restore { focus });
        Ok(())
    }
    fn restore(&mut self, window: &WebviewWindow, focus: bool) -> Result<(), String> {
        // Invalidates queued frames before restoring, hiding or releasing the page.
        self.motion = None;
        // Late page/configuration cleanup must not move the disappearing window.
        if self.suspended {
            self.settle(Ok(()));
            return Ok(());
        }
        let Some(snapshot) = self.snapshot.as_ref() else {
            return Ok(());
        };
        // Keep the snapshot if any API fails so the user can retry restoration.
        let mut error = None;
        let mut apply = |result: tauri::Result<()>| {
            if let Err(e) = result {
                error.get_or_insert_with(|| e.to_string());
            }
        };
        apply(window.set_always_on_top(snapshot.topmost));
        apply(window.set_decorations(snapshot.decorated));
        apply(window.set_resizable(snapshot.resizable));
        apply(window.set_maximizable(snapshot.maximizable));
        let config = window
            .app_handle()
            .config()
            .app
            .windows
            .iter()
            .find(|w| w.label == "main");
        let minimum = config.and_then(|w| Some(LogicalSize::new(w.min_width?, w.min_height?)));
        apply(window.set_min_size(minimum));
        apply(window.set_position(snapshot.bounds.position));
        // The animation already arrived at these outer bounds. Re-applying
        // them after decoration changes must not add the caption a second time.
        let geometry = motion::apply(window, snapshot.bounds);
        if snapshot.maximized {
            apply(window.maximize());
        }
        if focus {
            apply(window.show());
            apply(window.unminimize());
            apply(window.set_focus());
        }
        if let Err(e) = geometry {
            error.get_or_insert(e);
        }
        if let Some(error) = error {
            self.changed();
            self.settle(Err(error.clone()));
            return Err(error);
        }
        self.snapshot = None;
        self.armed = false;
        self.background_revision = self.background_revision.wrapping_add(1);
        self.changed();
        self.settle(Ok(()));
        Ok(())
    }
}

fn corner(
    origin: PhysicalPosition<i32>,
    area: PhysicalSize<u32>,
    size: PhysicalSize<u32>,
    margin: i32,
) -> PhysicalPosition<i32> {
    PhysicalPosition::new(
        origin.x.saturating_add(
            (area.width as i64 - size.width as i64 - margin as i64)
                .max(0)
                .min(i32::MAX as i64) as i32,
        ),
        origin.y.saturating_add(
            (area.height as i64 - size.height as i64 - margin as i64)
                .max(0)
                .min(i32::MAX as i64) as i32,
        ),
    )
}

#[derive(Default)]
pub struct Service(Mutex<State>);
impl Service {
    pub fn restore(&self, window: &WebviewWindow, focus: bool) -> bool {
        let Ok(mut state) = self.0.try_lock() else {
            return false;
        };
        let suspended = std::mem::replace(&mut state.suspended, false);
        if state.snapshot.is_none() {
            return false;
        }
        // Showing from the tray restores before visibility, without an animation.
        let result = if suspended {
            state.restore(window, focus)
        } else {
            state.leave(window, focus)
        };
        if let Err(error) = result {
            eprintln!("could not restore window: {error}");
        }
        true
    }
    pub fn shutdown(&self) {
        let mut state = self.0.lock().unwrap_or_else(|e| e.into_inner());
        state.motion = None;
        state.settle(Err("Window closed".into()));
    }
    pub fn suspend(&self) {
        let Ok(mut state) = self.0.try_lock() else {
            return;
        };
        state.suspend();
    }
    pub fn reset(&self, window: &WebviewWindow) {
        let Ok(mut state) = self.0.try_lock() else {
            return;
        };
        let _ = state.restore(window, false);
        state.watcher = None;
        state.options = Options::default();
        state.armed = false;
    }
    pub fn window_event(&self, window: &WebviewWindow, event: &tauri::WindowEvent) {
        // Window mutations can themselves emit events; do not reenter a transition.
        let Ok(mut state) = self.0.try_lock() else {
            return;
        };
        if matches!(event, tauri::WindowEvent::Focused(_)) {
            state.background_revision = state.background_revision.wrapping_add(1);
        }
        if matches!(event, tauri::WindowEvent::Focused(true))
            && state.snapshot.is_none()
            && !state.suspended
        {
            state.armed = true;
        }
        if matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            state.observe(window);
        }
        let background = matches!(event, tauri::WindowEvent::Focused(false))
            && !window.is_focused().unwrap_or(true)
            || matches!(event, tauri::WindowEvent::Resized(_))
                && window.is_minimized().unwrap_or(false);
        if background
            && state.armed
            && state.options.automatic
            && state.options.eligible
            && state.snapshot.is_none()
            && !state.suspended
            && window.is_visible().unwrap_or(false)
        {
            // One attempt per foreground/background cycle; failures do not loop.
            state.armed = false;
            let revision = state.background_revision;
            let owner = state.watcher.as_ref().map(|(id, _)| id.clone());
            let window = window.clone();
            // Let popup/focus changes settle and frontend eligibility IPC arrive.
            // Never refocus the app or turn a quick focus hop into a resize.
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let app = window.app_handle().clone();
                let _ = app.run_on_main_thread(move || {
                    let service = window.state::<Service>();
                    let Ok(mut state) = service.0.try_lock() else {
                        return;
                    };
                    if state.background_revision != revision
                        || state.watcher.as_ref().map(|(id, _)| id) != owner.as_ref()
                        || !state.options.eligible
                        || !state.options.automatic
                        || state.snapshot.is_some()
                        || state.suspended
                        || window.is_focused().unwrap_or(true)
                        || !window.is_visible().unwrap_or(false)
                        || !window
                            .state::<crate::application::Service>()
                            .allow_auto_presentation()
                    {
                        return;
                    }
                    if let Err(error) = state.enter(&window, true) {
                        eprintln!("could not enter automatic picture-in-picture: {error}");
                    }
                });
            });
        }
    }
}

#[tauri::command]
pub fn pip_watch(
    window: WebviewWindow,
    service: tauri::State<'_, Service>,
    watch_id: String,
    events: Channel<Status>,
) -> Result<(), String> {
    uuid::Uuid::parse_str(&watch_id).map_err(|_| "Invalid picture-in-picture watcher")?;
    let mut state = service.0.lock().unwrap_or_else(|e| e.into_inner());
    state.restore(&window, false)?;
    state.options = Options::default();
    state.watcher = Some((watch_id, events));
    state.armed = !state.suspended && window.is_focused().unwrap_or(false);
    state.observe(&window);
    state.notify();
    Ok(())
}
#[tauri::command]
pub fn pip_unwatch(
    window: WebviewWindow,
    service: tauri::State<'_, Service>,
    watch_id: String,
) -> Result<(), String> {
    let mut state = service.0.lock().unwrap_or_else(|e| e.into_inner());
    if state.owns(&watch_id).is_err() {
        return Ok(());
    }
    state.restore(&window, false)?;
    state.watcher = None;
    state.options = Options::default();
    Ok(())
}
#[tauri::command]
pub fn pip_configure(
    window: WebviewWindow,
    service: tauri::State<'_, Service>,
    watch_id: String,
    options: Options,
) -> Result<Status, String> {
    let mut state = service.0.lock().unwrap_or_else(|e| e.into_inner());
    state.owns(&watch_id)?;
    state.configure(options, window.is_focused().unwrap_or(false));
    if !options.eligible {
        state.restore(&window, false)?;
    }
    Ok(state.status())
}
async fn change(window: WebviewWindow, watch_id: String, enter: bool) -> Result<Status, String> {
    let (send, mut receive) = tauri::async_runtime::channel(1);
    let app = window.app_handle().clone();
    app.run_on_main_thread(move || {
        let service = window.state::<Service>();
        let mut state = service.0.lock().unwrap_or_else(|e| e.into_inner());
        let result = state.owns(&watch_id).and_then(|()| {
            if enter {
                state.enter(&window, false)
            } else {
                state.leave(&window, true)
            }
        });
        if result.is_ok() && state.motion.is_some() {
            state.waiters.push(send);
        } else {
            let _ = send.try_send(result.map(|()| state.status()));
        }
    })
    .map_err(|e| e.to_string())?;
    // Command completion includes the last native frame and flags restoration.
    // The UI's main-view guard must not unmount/switch its owner halfway through.
    receive.recv().await.ok_or("Window transition ended")?
}
#[tauri::command]
pub async fn pip_enter(window: WebviewWindow, watch_id: String) -> Result<Status, String> {
    change(window, watch_id, true).await
}
#[tauri::command]
pub async fn pip_exit(window: WebviewWindow, watch_id: String) -> Result<Status, String> {
    change(window, watch_id, false).await
}
#[tauri::command]
pub fn pip_drag(
    window: WebviewWindow,
    service: tauri::State<'_, Service>,
    watch_id: String,
) -> Result<(), String> {
    let state = service.0.lock().unwrap_or_else(|e| e.into_inner());
    state.owns(&watch_id)?;
    if state.snapshot.is_some() && !state.suspended && state.motion.is_none() {
        window.start_dragging().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn configure_rearms_background_entry_only_on_foreground_reactivation() {
        let enabled = Options {
            eligible: true,
            automatic: true,
            reduced_motion: false,
        };
        let mut state = State::default();
        state.configure(enabled, true);
        assert!(state.armed);

        state.armed = false; // A restore or dismissal consumed this focus cycle.
        state.configure(enabled, true);
        assert!(
            !state.armed,
            "ordinary configuration must not undo dismissal"
        );
        state.configure(Options::default(), true); // Leave.
        state.configure(enabled, true); // Join on the same focused page.
        assert!(state.armed);

        state.armed = false;
        state.configure(Options::default(), false);
        state.configure(enabled, false);
        assert!(
            !state.armed,
            "joining in the background must not steal presentation"
        );
    }
    #[test]
    fn caption_swap_preserves_outer_bounds_and_uses_logical_caption_height() {
        let decorated = FrameInsets {
            width: 16,
            height: 62,
            top: 54,
        };
        let frameless = FrameInsets {
            width: 16,
            height: 16,
            top: 8,
        };
        let content = PhysicalSize::new(1280, 800);
        let outer = decorated.outer_size(content);
        let compact_content = frameless.client_size(outer);
        assert_eq!(frameless.outer_size(compact_content), outer);
        assert_eq!(decorated.client_size(outer), content);
        assert_eq!(decorated.title_bar_height(frameless, 2.0), 23.0);
        assert_eq!(frameless.title_bar_height(frameless, 2.0), 36.0);
    }
    #[test]
    fn compact_placement_handles_negative_monitor_origins_and_small_displays() {
        assert_eq!(
            corner(
                (-1920, 0).into(),
                (1920, 1040).into(),
                (480, 310).into(),
                16
            ),
            PhysicalPosition::new(-496, 714)
        );
        assert_eq!(
            corner((0, 0).into(), (200, 150).into(), (480, 310).into(), 16),
            PhysicalPosition::new(0, 0)
        );
    }
    #[test]
    fn options_do_not_enable_background_entry_by_default() {
        let options = Options::default();
        assert!(!options.automatic && !options.eligible);
        assert!(serde_json::from_value::<Options>(
            serde_json::json!({"eligible":true,"automatic":true,"extra":true})
        )
        .is_err());
    }
    #[test]
    fn hiding_cancels_motion_and_settles_commands_without_discarding_the_snapshot() {
        let service = Service::default();
        let (send, mut receive) = tauri::async_runtime::channel(1);
        {
            let mut state = service.0.lock().unwrap();
            let bounds = Bounds {
                size: (1280, 800).into(),
                position: (0, 0).into(),
            };
            state.snapshot = Some(Snapshot {
                bounds,
                presented: bounds,
                maximized: false,
                decorated: true,
                topmost: false,
                resizable: true,
                maximizable: true,
            });
            state.motion = Some(Transition::new(1, bounds, bounds, Finish::Enter));
            state.armed = true;
            state.waiters.push(send);
        }
        // Suspension deliberately requires no native window or geometry calls.
        service.suspend();
        let state = service.0.lock().unwrap();
        assert!(
            state.snapshot.is_some(),
            "retain restoration for the next show"
        );
        assert!(state.suspended);
        assert!(!state.armed);
        assert!(!state.status().active);
        assert!(!state.status().transitioning);
        assert!(state.waiters.is_empty());
        assert_eq!(state.background_revision, 1);
        let status = receive.try_recv().unwrap().unwrap();
        assert!(!status.active && !status.transitioning);
    }
    #[test]
    fn late_configuration_cannot_rearm_a_suspended_window() {
        let mut state = State::default();
        state.suspend();
        let enabled = Options {
            eligible: true,
            automatic: true,
            reduced_motion: false,
        };
        // Focus/eligibility IPC may have been queued before hiding the window.
        state.configure(enabled, true);
        assert!(!state.armed);
        assert!(state.suspended);
        state.configure(Options::default(), false);
        state.configure(enabled, false);
        assert!(!state.armed);
        assert!(state.suspended);
    }
    #[test]
    fn shutdown_releases_pending_commands_and_invalidates_motion() {
        let service = Service::default();
        let (send, mut receive) = tauri::async_runtime::channel(1);
        {
            let mut state = service.0.lock().unwrap();
            state.motion = Some(Transition::new(
                1,
                Bounds {
                    size: (480, 386).into(),
                    position: (0, 0).into(),
                },
                Bounds {
                    size: (1280, 800).into(),
                    position: (0, 0).into(),
                },
                Finish::Restore { focus: true },
            ));
            state.waiters.push(send);
        }
        service.shutdown();
        assert!(!service.0.lock().unwrap().status().transitioning);
        assert!(receive.try_recv().unwrap().is_err());
    }
}
