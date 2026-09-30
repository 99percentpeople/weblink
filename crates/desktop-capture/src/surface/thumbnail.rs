//! A bounded, single-frame PNG for the local source picker; no media transport.
use super::{readback::Readback, FrameSink, Rotation, TextureFrame};
use crate::{Frames, Result, Session};
use std::{
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

pub(crate) fn capture(
    start: impl FnOnce(Arc<Mutex<Frames>>) -> Result<Box<dyn Session>>,
) -> Result<Vec<u8>> {
    let (sink, image) = collector();
    let session = start(Arc::new(Mutex::new(Frames {
        sink: Some(sink),
        thumbnail: true,
        ..Frames::default()
    })))?;
    let result = image
        .recv_timeout(Duration::from_secs(2))
        .map_err(|_| "The source did not provide a preview frame".to_string());
    // Always join and release capture, including timeout/conversion failures.
    let stopped = session.stop();
    let bytes = result??;
    stopped?;
    Ok(bytes)
}

fn collector() -> (Arc<dyn FrameSink>, mpsc::Receiver<Result<Vec<u8>>>) {
    let (sender, receiver) = mpsc::sync_channel(1);
    (Arc::new(Snapshot(Mutex::new(Some(sender)))), receiver)
}

struct Snapshot(Mutex<Option<mpsc::SyncSender<Result<Vec<u8>>>>>);
impl FrameSink for Snapshot {
    fn frame(&self, frame: TextureFrame<'_>) -> Result<()> {
        // Claim once, before mapping: later frames never allocate or queue pixels.
        let sender = self.0.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(sender) = sender {
            let result = (|| {
                let mut readback = Readback::default();
                readback.copy(&frame)?;
                let (width, height) = readback.size;
                let mapped = readback.map()?;
                encode(
                    mapped.bytes(),
                    mapped.stride() as usize,
                    width,
                    height,
                    frame.rotation,
                )
            })();
            let _ = sender.send(result);
        }
        Ok(())
    }
}

pub(crate) fn dimensions(width: u32, height: u32) -> (u32, u32) {
    let scale = (640.0 / width as f64).min(360.0 / height as f64).min(1.0);
    (
        (width as f64 * scale).max(1.0) as u32,
        (height as f64 * scale).max(1.0) as u32,
    )
}

pub(crate) fn encode(
    input: &[u8],
    stride: usize,
    width: u32,
    height: u32,
    rotation: Rotation,
) -> Result<Vec<u8>> {
    let (display_width, display_height) = match rotation {
        Rotation::Clockwise90 | Rotation::Clockwise270 => (height, width),
        _ => (width, height),
    };
    let (w, h) = dimensions(display_width, display_height);
    // Sample only the thumbnail's bounded output, without copying the full source
    // or retaining a GPU surface after this callback. Screenshots are opaque.
    let mut rgba = Vec::with_capacity((w * h * 4) as usize);
    for y in 0..h {
        for x in 0..w {
            let (dx, dy) = (x * display_width / w, y * display_height / h);
            let (sx, sy) = match rotation {
                Rotation::Identity => (dx, dy),
                Rotation::Clockwise90 => (dy, height - 1 - dx),
                Rotation::Clockwise180 => (width - 1 - dx, height - 1 - dy),
                Rotation::Clockwise270 => (width - 1 - dy, dx),
            };
            let offset = sy as usize * stride + sx as usize * 4;
            rgba.extend_from_slice(&[input[offset + 2], input[offset + 1], input[offset], 255]);
        }
    }
    let mut bytes = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut bytes, w, h);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        // Local IPC thumbnails favor latency over the smallest possible file.
        // This is still lossless and never changes the displayed pixels.
        encoder.set_compression(png::Compression::Fastest);
        let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&rgba).map_err(|e| e.to_string())?;
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn png_preserves_orientation_channels_and_ignores_row_padding() {
        let input: Vec<u8> = [1, 2, 99, 3, 4, 99, 5, 6, 99]
            .into_iter()
            .flat_map(|id| [id, 10, 20, 0])
            .collect();
        for (rotation, expected, size) in [
            (Rotation::Identity, [1, 2, 3, 4, 5, 6], (2, 3)),
            (Rotation::Clockwise90, [5, 3, 1, 6, 4, 2], (3, 2)),
            (Rotation::Clockwise180, [6, 5, 4, 3, 2, 1], (2, 3)),
            (Rotation::Clockwise270, [2, 4, 6, 1, 3, 5], (3, 2)),
        ] {
            let png = encode(&input, 12, 2, 3, rotation).unwrap();
            let mut reader = png::Decoder::new(std::io::Cursor::new(png))
                .read_info()
                .unwrap();
            let mut rgba = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut rgba).unwrap();
            assert_eq!((info.width, info.height), size);
            for (pixel, id) in rgba.as_chunks::<4>().0.iter().zip(expected) {
                assert_eq!(*pixel, [20, 10, id, 255]);
            }
        }
    }
    #[test]
    fn thumbnail_is_bounded_and_never_upscaled() {
        assert_eq!(dimensions(3840, 2160), (640, 360));
        assert_eq!(dimensions(2160, 3840), (202, 360));
        assert_eq!(dimensions(100, 80), (100, 80));
    }
}
