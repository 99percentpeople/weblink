//! Optional driver bitstream/pixel check using synthetic pixels; requires FFmpeg on PATH.
use super::*;

#[test]
#[ignore = "Requires Windows hardware codecs, ffmpeg/ffprobe and WEBLINK_COLOR_PROBE_DIR"]
fn hardware_color_bitstreams() {
    use crate::media::color::{ColorMatrix, ColorRange};
    use libwebrtc::native::yuv_helper::argb_to_i420_with_matrix;
    use std::{path::PathBuf, process::Command};
    let dir = PathBuf::from(
        std::env::var_os("WEBLINK_COLOR_PROBE_DIR").expect("WEBLINK_COLOR_PROBE_DIR"),
    );
    std::fs::create_dir_all(&dir).unwrap();
    let encoders = detect().unwrap();
    assert!(!encoders.is_empty(), "No usable hardware encoder");
    let _runtime = transform::Runtime::new().unwrap();
    let mut mismatches = Vec::new();
    for (index, info) in encoders.into_iter().enumerate() {
        for matrix in [ColorMatrix::Bt601, ColorMatrix::Bt709] {
            for range in [ColorRange::Limited, ColorRange::Full] {
                let options = MediaOptions {
                    color_matrix: matrix,
                    color_range: range,
                    ..Default::default()
                };
                let color = options.color_space();
                let mut pixels = Vec::new();
                for _y in 0..64 {
                    for x in 0..256_u16 {
                        pixels.extend_from_slice(&[x as u8, x as u8, x as u8, 255]);
                    }
                }
                let mut buffer = I420Buffer::new(256, 64);
                argb_to_i420_with_matrix(&pixels, 256 * 4, &mut buffer, color.yuv_matrix());
                let frame = Frame::from_i420(&buffer, None);
                let mut encoder = transform::Transform::open(
                    &info.id,
                    256,
                    64,
                    30,
                    25_000_000,
                    25_000_000,
                    color,
                    Arc::new(|| {}),
                )
                .unwrap();
                let mut bytes = Vec::new();
                let (mut inputs, mut outputs) = (0, 0);
                let started = Instant::now();
                while outputs < 3 && started.elapsed() < Duration::from_secs(5) {
                    for packet in encoder.poll().unwrap() {
                        bytes.extend_from_slice(&packet.bytes);
                        outputs += 1;
                    }
                    if inputs < 3 && encoder.ready() {
                        encoder.input(&frame.bytes, inputs * 33_333).unwrap();
                        inputs += 1;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                assert_eq!(outputs, 3, "Hardware colour probe did not encode");
                let extension = if info.id.ends_with(":h265") {
                    "hevc"
                } else {
                    "h264"
                };
                let file = dir.join(format!("{index}-{matrix:?}-{range:?}.{extension}"));
                std::fs::write(&file, bytes).unwrap();
                let report = Command::new("ffprobe")
                    .args([
                        "-v",
                        "error",
                        "-show_entries",
                        "stream=color_range,color_space,color_transfer,color_primaries",
                        "-of",
                        "json",
                    ])
                    .arg(&file)
                    .output()
                    .expect("ffprobe must be on PATH");
                assert!(
                    report.status.success(),
                    "{}",
                    String::from_utf8_lossy(&report.stderr)
                );
                let json: serde_json::Value = serde_json::from_slice(&report.stdout).unwrap();
                let tags = &json["streams"][0];
                println!("COLOR_BITSTREAM {} {matrix:?} {range:?}: {tags}", info.name);
                let decoded = Command::new("ffmpeg")
                    .args(["-v", "error", "-i"])
                    .arg(&file)
                    .args([
                        "-frames:v",
                        "1",
                        "-pix_fmt",
                        if range == ColorRange::Full {
                            "yuvj420p"
                        } else {
                            "yuv420p"
                        },
                        "-f",
                        "rawvideo",
                        "pipe:1",
                    ])
                    .output()
                    .expect("ffmpeg must be on PATH");
                assert!(
                    decoded.status.success(),
                    "{}",
                    String::from_utf8_lossy(&decoded.stderr)
                );
                assert_eq!(decoded.stdout.len(), 256 * 64 * 3 / 2);
                let (expected, _, _) = buffer.data();
                let max_error = decoded.stdout[..256]
                    .iter()
                    .zip(&expected[..256])
                    .map(|(a, b)| a.abs_diff(*b))
                    .max()
                    .unwrap();
                assert!(
                    max_error <= 2,
                    "Encoded luma differs from supplied pixels by {max_error}"
                );
                if tags["color_range"]
                    != if range == ColorRange::Full {
                        "pc"
                    } else {
                        "tv"
                    }
                    || tags["color_space"]
                        != if matrix == ColorMatrix::Bt709 {
                            "bt709"
                        } else {
                            "smpte170m"
                        }
                    || tags["color_transfer"] != "iec61966-2-1"
                    || tags["color_primaries"] != "bt709"
                {
                    mismatches.push(format!("{} {matrix:?} {range:?}: {tags}", info.name));
                }
            }
        }
    }
    assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}
