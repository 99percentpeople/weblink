use base64::{engine::general_purpose::STANDARD, Engine};
use std::{
    io::{Cursor, Write},
    path::Path,
};

/// The OS source icon outlives individual toasts and is independent of peer avatars.
#[cfg(any(windows, test))]
pub fn app_icon(directory: &Path) -> Result<std::path::PathBuf, String> {
    const PNG: &[u8] = include_bytes!("../../icons/icon.png");
    let path = directory.join("app-icon.png");
    if std::fs::read(&path).ok().as_deref() != Some(PNG) {
        std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
        std::fs::write(&path, PNG).map_err(|e| e.to_string())?;
    }
    Ok(path)
}

/// A local raster owned by one live notification. Never accepts a remote URL or file path.
#[cfg_attr(not(any(windows, test)), allow(dead_code))]
pub struct Icon(tempfile::TempPath);

impl Icon {
    pub fn new(data: &str) -> Result<Self, String> {
        let bytes = decode(data)?;
        let mut file = tempfile::Builder::new()
            .prefix("weblink-notification-")
            .suffix(".png")
            .tempfile()
            .map_err(|e| e.to_string())?;
        file.write_all(&bytes).map_err(|e| e.to_string())?;
        // Close the writer before handing the path to the OS notification service.
        Ok(Self(file.into_temp_path()))
    }

    #[cfg_attr(not(any(windows, test)), allow(dead_code))]
    pub fn path(&self) -> &Path {
        &self.0
    }

    #[cfg(any(windows, test))]
    pub fn uri(&self) -> String {
        tauri::Url::from_file_path(self.path())
            .expect("absolute temporary image path")
            .into()
    }
}

fn decode(data: &str) -> Result<Vec<u8>, String> {
    if data.len() > 128 * 1024 {
        return Err("Notification icon too large".into());
    }
    let bytes = STANDARD
        .decode(
            data.strip_prefix("data:image/png;base64,")
                .ok_or("Expected PNG data URL")?,
        )
        .map_err(|e| e.to_string())?;
    let mut decoder = png::Decoder::new(Cursor::new(&bytes));
    decoder.set_limits(png::Limits { bytes: 1024 * 1024 });
    let header = decoder.read_header_info().map_err(|e| e.to_string())?;
    if header.width == 0 || header.height == 0 || header.width > 128 || header.height > 128 {
        return Err("Notification icon dimensions too large".into());
    }
    let mut reader = decoder.read_info().map_err(|e| e.to_string())?;
    let mut pixels = vec![0; reader.output_buffer_size().ok_or("Invalid PNG size")?];
    reader.next_frame(&mut pixels).map_err(|e| e.to_string())?;
    reader.finish().map_err(|e| e.to_string())?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_icon_is_persistent_and_repairs_stale_artwork() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("notifications");
        let path = app_icon(&root).unwrap();
        let expected = include_bytes!("../../icons/icon.png");
        assert_eq!(std::fs::read(&path).unwrap(), expected);
        assert_eq!(app_icon(&root).unwrap(), path);
        std::fs::write(&path, "outdated").unwrap();
        assert_eq!(app_icon(&root).unwrap(), path);
        assert_eq!(std::fs::read(&path).unwrap(), expected);
    }

    pub fn data_url(size: u32) -> String {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, size, size);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&vec![255; (size * size * 4) as usize])
                .unwrap();
        }
        format!("data:image/png;base64,{}", STANDARD.encode(bytes))
    }

    #[test]
    fn bounded_png_is_local_and_removed_with_the_notification() {
        let data = data_url(96);
        let icon = Icon::new(&data).unwrap();
        let path = icon.path().to_path_buf();
        assert_eq!(std::fs::read(&path).unwrap(), decode(&data).unwrap());
        assert_eq!(
            tauri::Url::parse(&icon.uri())
                .unwrap()
                .to_file_path()
                .unwrap(),
            path
        );
        drop(icon);
        assert!(!path.exists());
    }

    #[test]
    fn rejects_urls_wrong_formats_corruption_and_oversized_images() {
        for data in [
            "https://example.com/avatar.png".to_string(),
            "file:///private/avatar.png".into(),
            "data:image/svg+xml;base64,PHN2Zz4=".into(),
            "data:image/png;base64,YmFk".into(),
            data_url(129),
            format!("data:image/png;base64,{}", "A".repeat(128 * 1024)),
        ] {
            assert!(Icon::new(&data).is_err());
        }
        let data = data_url(96);
        let bytes = decode(&data).unwrap();
        assert!(decode(&format!(
            "data:image/png;base64,{}",
            STANDARD.encode(&bytes[..bytes.len() / 2])
        ))
        .is_err());
    }
}
