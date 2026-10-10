//! Borrowed GPU frames, independent of WebRTC, encoding and Tauri.
pub(crate) mod readback;
mod scale;
pub(crate) mod thumbnail;
use windows::Win32::Graphics::Direct3D11::{ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D};

/// The texture is valid only during `FrameSink::frame`. Copy it before returning.
/// The capture backend owns acquisition/release; consumers own conversion and pacing.
pub struct TextureFrame<'a> {
    pub device: &'a ID3D11Device,
    pub context: &'a ID3D11DeviceContext,
    pub texture: &'a ID3D11Texture2D,
    /// Clockwise rotation required to produce the displayed orientation.
    pub rotation: Rotation,
    pub cursor: Option<&'a Cursor>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Rotation {
    #[default]
    Identity,
    Clockwise90,
    Clockwise180,
    Clockwise270,
}

pub trait FrameSink: Send + Sync {
    fn frame(&self, frame: TextureFrame<'_>) -> Result<(), String>;
}

impl super::Frames {
    pub(crate) fn deliver(
        stats: &std::sync::Mutex<Self>,
        frame: TextureFrame<'_>,
    ) -> Result<(), String> {
        let mut desc = Default::default();
        unsafe { frame.texture.GetDesc(&mut desc) };
        let mut stats = stats.lock().unwrap_or_else(|e| e.into_inner());
        let (width, height) = match frame.rotation {
            Rotation::Clockwise90 | Rotation::Clockwise270 => (desc.Height, desc.Width),
            _ => (desc.Width, desc.Height),
        };
        stats.arrived(width, height, std::time::Instant::now());
        let sink = stats.sink.clone();
        drop(stats);
        if let Some(sink) = sink {
            sink.frame(frame)?;
        }
        Ok(())
    }
}

/// A separate desktop cursor, in displayed monitor coordinates. WGC composites its own cursor.
#[derive(Clone, Debug, Default)]
pub struct Cursor {
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub pitch: u32,
    pub shape: CursorShape,
    pub bytes: std::sync::Arc<Vec<u8>>,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorShape {
    #[default]
    Color,
    Monochrome,
    MaskedColor,
}
