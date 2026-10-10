//! Resolve remote identifiers against a capture owned by this local process.
use super::Context;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Weak,
    },
    thread::Thread,
};
use weblink_desktop_capture::{geometry::PixelRect, CaptureService};
use weblink_desktop_input::{
    authorization::Binding,
    engine::TrustedTarget,
    input::{Geometry, Rect},
    protocol::Target,
};

pub(super) struct GeometryWatch(Option<Box<dyn FnOnce() + Send + Sync>>);
impl GeometryWatch {
    pub(super) fn new(cancel: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self(Some(Box::new(cancel)))
    }
}
impl Drop for GeometryWatch {
    fn drop(&mut self) {
        if let Some(cancel) = self.0.take() {
            cancel();
        }
    }
}
pub(super) struct GeometryChanges {
    revision: Arc<AtomicU64>,
    _watch: GeometryWatch,
}
impl GeometryChanges {
    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::Acquire)
    }
}
#[derive(Default)]
pub(super) struct GeometryWatches(HashMap<String, Weak<GeometryChanges>>);
impl GeometryWatches {
    pub fn subscribe(
        &mut self,
        capture: Arc<dyn GeometrySource>,
        binding: &Binding,
        owner: Option<Thread>,
    ) -> Result<Arc<GeometryChanges>, String> {
        // One native watcher per capture, regardless of the number of viewers.
        // The last peer drops it; retired callbacks cannot mutate a replacement.
        self.0.retain(|_, watch| watch.strong_count() != 0);
        if let Some(changes) = self
            .0
            .get(&binding.capture_session_id)
            .and_then(Weak::upgrade)
        {
            return Ok(changes);
        }
        let revision = Arc::new(AtomicU64::new(1));
        let changed = revision.clone();
        let watch = capture.watch(
            binding,
            Box::new(move || {
                changed.fetch_add(1, Ordering::AcqRel);
                if let Some(owner) = &owner {
                    owner.unpark();
                }
            }),
        )?;
        let changes = Arc::new(GeometryChanges {
            revision,
            _watch: watch,
        });
        self.0
            .insert(binding.capture_session_id.clone(), Arc::downgrade(&changes));
        Ok(changes)
    }
}
pub(super) trait GeometrySource: Send + Sync {
    fn watch(
        self: Arc<Self>,
        binding: &Binding,
        changed: Box<dyn Fn() + Send>,
    ) -> Result<GeometryWatch, String>;
    fn is_current(&self, binding: &Binding) -> bool;
    fn cursor_visibility_supported(&self, binding: &Binding) -> bool;
    fn set_cursor_visible(&self, binding: &Binding, visible: bool) -> Result<(), String>;
}
impl GeometrySource for CaptureService {
    fn watch(
        self: Arc<Self>,
        binding: &Binding,
        changed: Box<dyn Fn() + Send>,
    ) -> Result<GeometryWatch, String> {
        let id = uuid::Uuid::new_v4().to_string();
        CaptureService::watch(
            &self,
            binding.capture_session_id.clone(),
            id.clone(),
            Box::new(move |_| {
                changed();
                true
            }),
        )?;
        Ok(GeometryWatch::new(move || self.unwatch(id)))
    }
    fn cursor_visibility_supported(&self, binding: &Binding) -> bool {
        self.cursor_visibility_supported(binding.capture_session_id.clone())
    }
    fn set_cursor_visible(&self, binding: &Binding, visible: bool) -> Result<(), String> {
        self.set_cursor_visible(binding.capture_session_id.clone(), visible)
    }
    fn is_current(&self, binding: &Binding) -> bool {
        self.display_geometry(binding.capture_session_id.clone())
            .is_ok_and(|layout| layout.revision == binding.target.geometry_revision)
    }
}
pub(super) fn resolve(
    capture: &CaptureService,
    owner: &str,
    context: Context,
    session: String,
    media: String,
) -> Result<TrustedTarget, String> {
    let layout = capture.display_geometry(session.clone())?;
    let status = capture.status(session.clone())?;
    let source = status.source.ok_or("Capture stopped")?;
    let display = layout
        .displays
        .iter()
        .find(|d| d.source_id == source.id)
        .ok_or("Display unavailable")?;
    let rect = |r: &PixelRect| Rect {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
    };
    let binding = Binding {
        room_generation: owner.into(),
        peer_generation: context.peer_generation,
        client_id: context.client_id,
        capture_session_id: session,
        target: Target {
            source_id: context.source_id,
            media_id: media.clone(),
            geometry_revision: layout.revision,
        },
    };
    Ok(TrustedTarget {
        binding,
        geometry: Geometry {
            display: rect(&display.bounds),
            desktop: rect(&layout.virtual_bounds),
        },
    })
}
