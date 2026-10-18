use super::*;
use crate::surface::{gpu::ContextLock, Rotation, TextureFrame};
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

fn image(device: &ID3D11Device) -> ID3D11Texture2D {
    let pixels = [32u8, 64, 192, 255].repeat(320 * 180);
    let mut texture = None;
    unsafe {
        device
            .CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: 320,
                    Height: 180,
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
                    SysMemPitch: 320 * 4,
                    SysMemSlicePitch: 0,
                }),
                Some(&mut texture),
            )
            .unwrap();
    }
    texture.unwrap()
}

#[test]
#[ignore = "Requires Windows GPU NV12 texture input for hardware encoding"]
fn gpu_nv12_surface_encodes_with_h264_and_hevc_without_memory_input() {
    let _runtime = transform::Runtime::new().unwrap();
    let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
    let texture = image(&device);
    let frame = TextureFrame {
        device: &device,
        context: &context,
        texture: &texture,
        rotation: Rotation::Identity,
        cursor: None,
    };
    let pool = gpu::CapturePool::new(&frame, Arc::new(|| {}));
    let captured = pool.capture(&frame, false).unwrap().unwrap();
    for info in detect().unwrap() {
        let options = MediaOptions::default();
        let mut converter = gpu::Converter::new(&device, (320, 180), Arc::new(|| {})).unwrap();
        let mut encoder = transform::Transform::open(
            &info.id,
            320,
            180,
            30,
            1_000_000,
            1_000_000,
            options.color_space(),
            Arc::new(|| {}),
            Some(&device),
        )
        .unwrap();
        let mut submitted = false;
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut count = 0;
        while Instant::now() < deadline {
            count += encoder.poll().unwrap().len();
            if count > 0 {
                break;
            }
            if !submitted && encoder.ready() {
                let surface = converter.convert(&captured, &options).unwrap().unwrap();
                encoder.input_gpu(surface, 1000).unwrap();
                submitted = true;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(count > 0, "{} produced no GPU output", info.id);
        println!("GPU input verified: {}", info.name);
    }
    let _guard = ContextLock::enter(&context).unwrap();
}
