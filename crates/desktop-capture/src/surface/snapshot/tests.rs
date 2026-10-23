use super::*;
use crate::{geometry::PixelRect, snapshot::SnapshotOptions};

fn decode(bytes: Vec<u8>) -> (u32, u32, Vec<u8>) {
    let mut reader = png::Decoder::new(std::io::Cursor::new(bytes))
        .read_info()
        .unwrap();
    let mut rgb = vec![0; reader.output_buffer_size().unwrap()];
    let info = reader.next_frame(&mut rgb).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgb);
    (info.width, info.height, rgb)
}

fn noise(width: u32, height: u32) -> Vec<u8> {
    let mut bytes = vec![0; (width * height * 4) as usize];
    let mut random = 0x12345678_u32;
    for pixel in bytes.chunks_exact_mut(4) {
        random ^= random << 13;
        random ^= random >> 17;
        random ^= random << 5;
        pixel.copy_from_slice(&random.to_le_bytes());
    }
    bytes
}

#[test]
fn default_square_fits_budget_even_for_incompressible_pixels() {
    let source = PixelRect {
        left: 0,
        top: 0,
        width: 1024,
        height: 1024,
    };
    let area = SnapshotOptions::default().region(&source).unwrap();
    let input = noise(source.width, source.height);
    let png = encode(&input, 1024 * 4, 1024, 1024, Rotation::Identity, &area).unwrap();
    assert!(png.len() <= MAX_PNG_BYTES);
    let (w, h, rgb) = decode(png);
    assert_eq!((w, h), (1024, 1024));
    for (actual, expected) in rgb.chunks_exact(3).zip(input.chunks_exact(4)) {
        assert_eq!(actual, [expected[2], expected[1], expected[0]]);
    }
}

#[test]
fn repeated_texture_compresses_without_losing_small_pixel_details() {
    let source = PixelRect {
        left: 0,
        top: 0,
        width: 512,
        height: 256,
    };
    let tile = noise(64, source.height);
    let mut input = Vec::new();
    for row in tile.chunks_exact(64 * 4) {
        for _ in 0..8 {
            input.extend_from_slice(row);
        }
    }
    let area = SnapshotOptions::default().region(&source).unwrap();
    let png = encode(&input, 512 * 4, 512, 256, Rotation::Identity, &area).unwrap();
    let expected: Vec<u8> = input
        .chunks_exact(4)
        .flat_map(|p| [p[2], p[1], p[0]])
        .collect();
    let mut previous = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut previous, 512, 256);
        encoder.set_color(png::ColorType::Rgb);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        encoder
            .write_header()
            .unwrap()
            .write_image_data(&expected)
            .unwrap();
    }
    assert!(
        png.len() < previous.len() / 2,
        "compressed {} bytes versus {} with the previous encoder",
        png.len(),
        previous.len()
    );
    assert_eq!(decode(png), (512, 256, expected));
}

#[test]
fn crop_samples_oriented_source_pixels_without_padding_or_thumbnail_loss() {
    let input: Vec<u8> = [1, 2, 99, 3, 4, 99, 5, 6, 99]
        .into_iter()
        .flat_map(|id| [id, 10, 20, 0])
        .collect();
    for (rotation, size, expected) in [
        (Rotation::Identity, (2, 3), vec![4, 6]),
        (Rotation::Clockwise90, (3, 2), vec![4, 2]),
        (Rotation::Clockwise180, (2, 3), vec![3, 1]),
        (Rotation::Clockwise270, (3, 2), vec![3, 5]),
    ] {
        let source = PixelRect {
            left: -100,
            top: -20,
            width: size.0,
            height: size.1,
        };
        let rect = PixelRect {
            left: -99,
            top: -19,
            width: size.0 - 1,
            height: size.1 - 1,
        };
        let area = SnapshotOptions {
            rect: Some(rect.clone()),
            ..Default::default()
        }
        .region(&source)
        .unwrap();
        let (w, h, rgb) = decode(encode(&input, 12, 2, 3, rotation, &area).unwrap());
        assert_eq!((w, h), (rect.width, rect.height));
        assert_eq!(
            rgb,
            expected
                .into_iter()
                .flat_map(|id| [20, 10, id])
                .collect::<Vec<_>>()
        );
    }
}

#[test]
fn resize_interpolates_pixel_centers_and_rejects_inconsistent_frames() {
    let source = PixelRect {
        left: 0,
        top: 0,
        width: 2,
        height: 2,
    };
    let area = SnapshotOptions {
        max_width: 1,
        max_height: 1,
        rect: None,
    }
    .region(&source)
    .unwrap();
    let input: Vec<u8> = [0, 255, 255, 0]
        .into_iter()
        .flat_map(|v| [v, v, v, 0])
        .collect();
    assert_eq!(
        decode(encode(&input, 8, 2, 2, Rotation::Identity, &area).unwrap()),
        (1, 1, vec![128; 3])
    );
    assert!(encode(&input[..12], 8, 2, 2, Rotation::Identity, &area).is_err());
    assert!(encode(&input, 4, 2, 2, Rotation::Identity, &area).is_err());
    let mut outside = area;
    outside.x = 1;
    assert!(encode(&input, 8, 2, 2, Rotation::Identity, &outside).is_err());
}

#[test]
fn high_resolution_output_is_not_limited_by_picker_thumbnail_size() {
    let source = PixelRect {
        left: 0,
        top: 0,
        width: 2048,
        height: 1200,
    };
    let area = SnapshotOptions {
        max_width: 2048,
        max_height: 2048,
        rect: None,
    }
    .region(&source)
    .unwrap();
    let bytes = vec![42; (source.width * source.height * 4) as usize];
    let (w, h, rgb) =
        decode(encode(&bytes, 2048 * 4, 2048, 1200, Rotation::Identity, &area).unwrap());
    assert_eq!((w, h), (2048, 1200));
    assert!(rgb.iter().all(|&v| v == 42));
}

#[test]
fn incompressible_screenshot_reports_size_limit_without_reducing_resolution() {
    let source = PixelRect {
        left: 0,
        top: 0,
        width: 2048,
        height: 1024,
    };
    let area = SnapshotOptions {
        max_width: 2048,
        max_height: 2048,
        rect: None,
    }
    .region(&source)
    .unwrap();
    let bytes = noise(source.width, source.height);
    assert_eq!(
        encode(&bytes, 2048 * 4, 2048, 1024, Rotation::Identity, &area).unwrap_err(),
        "RESULT_TOO_LARGE"
    );
}
