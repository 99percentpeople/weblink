//! Resolve remote identifiers against a capture owned by this local process.
use super::Context;
use weblink_desktop_capture::{geometry::PixelRect, CaptureService};
use weblink_desktop_input::{
    authorization::Binding,
    engine::TrustedTarget,
    input::{Geometry, Rect},
    protocol::Target,
};

pub(super) trait GeometrySource: Send + Sync {
    fn is_current(&self, binding: &Binding) -> bool;
}
impl GeometrySource for CaptureService {
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
