//! Opt-in, fixed-input comparison. Never captures the desktop or changes a share.
use super::*;
use crate::{
    media::{color::ColorMatrix, MediaOptions},
    surface::{Rotation, TextureFrame},
};
use serde_json::json;
use std::{fs::File, io::Write, path::Path, sync::mpsc, thread};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

const WIDTH: u32 = 2560;
const HEIGHT: u32 = 1440;
const FPS: u32 = 120;
const PHASES: usize = 8;
const FRAMES: usize = 240;
const WARMUP: usize = 40;

fn write_nv12(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    surface: &gpu::Surface,
    file: &mut File,
) {
    unsafe {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        surface.texture.GetDesc(&mut desc);
        desc.BindFlags = 0;
        desc.Usage = D3D11_USAGE_STAGING;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        let mut staging = None;
        device
            .CreateTexture2D(&desc, None, Some(&mut staging))
            .unwrap();
        let staging = staging.unwrap();
        context.CopyResource(&staging, &surface.texture);
        let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
        context
            .Map(&staging, 0, D3D11_MAP_READ, 0, Some(&mut mapped))
            .unwrap();
        for row in 0..HEIGHT * 3 / 2 {
            file.write_all(std::slice::from_raw_parts(
                mapped
                    .pData
                    .cast::<u8>()
                    .add((row * mapped.RowPitch) as usize),
                WIDTH as usize,
            ))
            .unwrap();
        }
        context.Unmap(&staging, 0);
    }
}

fn surfaces(
    device: &ID3D11Device,
    context: &ID3D11DeviceContext,
    directory: &Path,
) -> Vec<Arc<Lease<gpu::Surface>>> {
    let mut reference = File::create(directory.join("reference.nv12")).unwrap();
    let options = MediaOptions {
        color_matrix: ColorMatrix::Bt709,
        ..Default::default()
    };
    let mut converter = gpu::Converter::new(device, (WIDTH, HEIGHT), Arc::new(|| {})).unwrap();
    (0..PHASES)
        .map(|phase| {
            let mut pixels = vec![0u8; (WIDTH * HEIGHT * 4) as usize];
            for y in 0..HEIGHT {
                for x in 0..WIDTH {
                    let shifted = x + phase as u32 * 7;
                    let grain = ((shifted / 4).wrapping_mul(747796405)
                        ^ (y / 4).wrapping_mul(2891336453))
                        >> 24;
                    let value = if y < HEIGHT / 2 {
                        ((shifted / 5 + y / 3) % 220 + 16) as u8
                    } else if x < WIDTH / 2 {
                        if shifted % 17 < 2 || y % 23 < 2 {
                            225
                        } else {
                            35
                        }
                    } else {
                        grain as u8
                    };
                    let offset = ((y * WIDTH + x) * 4) as usize;
                    pixels[offset..offset + 4].copy_from_slice(&[
                        value,
                        value.saturating_add((y % 29) as u8),
                        value.saturating_sub((x % 31) as u8),
                        255,
                    ]);
                }
            }
            let mut texture = None;
            unsafe {
                device
                    .CreateTexture2D(
                        &D3D11_TEXTURE2D_DESC {
                            Width: WIDTH,
                            Height: HEIGHT,
                            MipLevels: 1,
                            ArraySize: 1,
                            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                            SampleDesc: DXGI_SAMPLE_DESC {
                                Count: 1,
                                Quality: 0,
                            },
                            Usage: D3D11_USAGE_DEFAULT,
                            BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                            ..Default::default()
                        },
                        Some(&D3D11_SUBRESOURCE_DATA {
                            pSysMem: pixels.as_ptr().cast(),
                            SysMemPitch: WIDTH * 4,
                            SysMemSlicePitch: 0,
                        }),
                        Some(&mut texture),
                    )
                    .unwrap();
            }
            let texture = texture.unwrap();
            let frame = TextureFrame {
                device,
                context,
                texture: &texture,
                rotation: Rotation::Identity,
                cursor: None,
                dirty_regions: None,
            };
            let captured = gpu::CapturePool::new(&frame, Arc::new(|| {}))
                .capture(&frame, false)
                .unwrap()
                .unwrap();
            let surface = converter.convert(&captured, &options).unwrap().unwrap();
            write_nv12(device, context, &surface, &mut reference);
            surface
        })
        .collect()
}

fn percentile(values: &[f64], fraction: f64) -> f64 {
    let mut ordered = values.to_vec();
    ordered.sort_by(f64::total_cmp);
    ordered[((ordered.len() - 1) as f64 * fraction) as usize]
}

#[test]
#[ignore = "Opt-in NVENC preset benchmark; requires WEBLINK_NVENC_COMPARE_DIR (new directory)"]
fn compare_interactive_presets_on_identical_1440p_input() {
    let directory =
        std::env::var_os("WEBLINK_NVENC_COMPARE_DIR").expect("Set a new output directory");
    let directory = Path::new(&directory);
    std::fs::create_dir(directory).expect("Comparison output must be a new directory");
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    assert!(is_nvidia(&device));
    let surfaces = surfaces(&device, &context, directory);
    struct Timer;
    impl Drop for Timer {
        fn drop(&mut self) {
            unsafe {
                windows::Win32::Media::timeEndPeriod(1);
            }
        }
    }
    assert_eq!(unsafe { windows::Win32::Media::timeBeginPeriod(1) }, 0);
    let _timer = Timer;
    let mut runs = Vec::new();
    for round in 0..2 {
        let presets = if round == 0 {
            [
                EncodingPreset::Balanced,
                EncodingPreset::Latency,
                EncodingPreset::Quality,
            ]
        } else {
            [
                EncodingPreset::Quality,
                EncodingPreset::Latency,
                EncodingPreset::Balanced,
            ]
        };
        for bitrate in [12_000_000, 147_776_000] {
            for codec in [Codec::H264, Codec::Hevc] {
                for preset in presets {
                    let name = serde_json::to_value(preset)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned();
                    let extension = match codec {
                        Codec::H264 => "h264",
                        Codec::Hevc => "h265",
                    };
                    let filename = format!("{extension}-{bitrate}-{name}-{round}.{extension}");
                    let mut output = File::create(directory.join(&filename)).unwrap();
                    let (tx, rx) = mpsc::channel();
                    let wake: Wake = Arc::new(move || {
                        let _ = tx.send(());
                    });
                    let configuration = Configuration {
                        codec,
                        width: WIDTH,
                        height: HEIGHT,
                        fps: FPS,
                        bitrate,
                        bitrate_limit: bitrate,
                        color: MediaOptions {
                            color_matrix: ColorMatrix::Bt709,
                            ..Default::default()
                        }
                        .color_space(),
                    };
                    let mut encoder =
                        Encoder::open_with_preset(&device, configuration, preset, wake).unwrap();
                    let started = Instant::now();
                    let mut times = Vec::new();
                    let mut bytes = 0usize;
                    let mut sizes = Vec::new();
                    let mut keyframes = Vec::new();
                    for index in 0..FRAMES {
                        let due = started + Duration::from_secs_f64(index as f64 / FPS as f64);
                        if let Some(delay) = due.checked_duration_since(Instant::now()) {
                            thread::sleep(delay);
                        }
                        let timestamp = index as i64 * 1_000_000 / FPS as i64;
                        let input_at = Instant::now();
                        assert!(encoder
                            .input_gpu(surfaces[index % PHASES].clone(), timestamp)
                            .unwrap());
                        let packet = loop {
                            let packets = encoder.poll().unwrap();
                            if let Some(packet) = packets.into_iter().next() {
                                break packet;
                            }
                            assert!(
                                input_at.elapsed() < Duration::from_secs(3),
                                "NVENC output timeout"
                            );
                            let _ = rx.recv_timeout(Duration::from_millis(100));
                        };
                        let elapsed = input_at.elapsed().as_secs_f64() * 1000.;
                        assert_eq!(packet.timestamp_us, timestamp);
                        if index >= WARMUP {
                            times.push(elapsed);
                            sizes.push(packet.bytes.len() as f64);
                        }
                        if packet.keyframe {
                            keyframes.push((index, packet.bytes.len()));
                        }
                        bytes += packet.bytes.len();
                        output.write_all(&packet.bytes).unwrap();
                    }
                    let mut result = json!({ "round": round, "codec": extension, "preset": preset, "bitrate": bitrate,
                        "file": filename, "frames": FRAMES, "warmupFrames": WARMUP, "bytes": bytes,
                        "completionMs": { "median": percentile(&times, 0.5), "p95": percentile(&times, 0.95), "max": percentile(&times, 1.) },
                        "overFrameBudget": times.iter().filter(|ms| **ms > 1000. / FPS as f64).count(),
                        "frameBytes": { "median": percentile(&sizes, 0.5), "p95": percentile(&sizes, 0.95), "max": percentile(&sizes, 1.) },
                        "keyframes": keyframes, "controls": encoder.control_status() });
                    eprintln!("PRESET_COMPARE {result}");
                    result["completionSamplesMs"] = json!(times);
                    runs.push(result);
                }
            }
        }
    }
    let report = json!({ "width": WIDTH, "height": HEIGHT, "fps": FPS, "phases": PHASES,
        "scope": "Synthetic preconverted NV12 input, one frame in flight, event-driven input-to-output including packet copy; not end-to-end latency. Other GPU applications are not stopped.",
        "runs": runs });
    std::fs::write(
        directory.join("comparison.json"),
        serde_json::to_vec_pretty(&report).unwrap(),
    )
    .unwrap();
}
