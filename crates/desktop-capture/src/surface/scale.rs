//! D3D11 bilinear resize before CPU readback. No video-processor format restrictions.
use std::sync::OnceLock;
use windows::{
    core::{s, Error, Result, PCSTR},
    Win32::Graphics::{
        Direct3D::{Fxc::D3DCompile, ID3DInclude, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST},
        Direct3D11::*,
    },
};
const SHADER: &str = r#"
struct Vertex { float4 position : SV_POSITION; float2 uv : TEXCOORD0; };
Vertex vs(uint id : SV_VertexID) {
    Vertex v;
    v.uv = float2((id << 1) & 2, id & 2);
    v.position = float4(v.uv * float2(2, -2) + float2(-1, 1), 0, 1);
    return v;
}
Texture2D image : register(t0);
SamplerState linearClamp : register(s0);
float4 ps(Vertex v) : SV_TARGET { return image.Sample(linearClamp, v.uv); }
"#;
fn bytecode(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>> {
    unsafe {
        let mut blob = None;
        let mut errors = None;
        D3DCompile(
            SHADER.as_ptr().cast(),
            SHADER.len(),
            PCSTR::null(),
            None,
            None::<&ID3DInclude>,
            entry,
            target,
            0,
            0,
            &mut blob,
            Some(&mut errors),
        )?;
        let blob = blob.ok_or_else(Error::from_thread)?;
        Ok(
            std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize())
                .to_vec(),
        )
    }
}
pub(crate) struct Scaler {
    pub size: (u32, u32),
    context: ID3D11DeviceContext,
    texture: ID3D11Texture2D,
    input: ID3D11ShaderResourceView,
    output: ID3D11RenderTargetView,
    vertex: ID3D11VertexShader,
    pixel: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    raster: ID3D11RasterizerState,
}
impl Scaler {
    pub fn new(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source: &ID3D11Texture2D,
        size: (u32, u32),
    ) -> Result<Self> {
        static SHADERS: OnceLock<Result<(Vec<u8>, Vec<u8>)>> = OnceLock::new();
        let (vs, ps) = SHADERS
            .get_or_init(|| {
                Ok((
                    bytecode(s!("vs"), s!("vs_4_0"))?,
                    bytecode(s!("ps"), s!("ps_4_0"))?,
                ))
            })
            .as_ref()
            .map_err(Clone::clone)?;
        unsafe {
            let mut vertex = None;
            device.CreateVertexShader(vs, None, Some(&mut vertex))?;
            let mut pixel = None;
            device.CreatePixelShader(ps, None, Some(&mut pixel))?;
            let mut input = None;
            device.CreateShaderResourceView(source, None, Some(&mut input))?;
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            source.GetDesc(&mut desc);
            desc.Width = size.0;
            desc.Height = size.1;
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            desc.BindFlags = D3D11_BIND_RENDER_TARGET.0 as u32;
            let mut texture = None;
            device.CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = texture.unwrap();
            let mut output = None;
            device.CreateRenderTargetView(&texture, None, Some(&mut output))?;
            let mut sampler = None;
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut sampler),
            )?;
            let mut raster = None;
            device.CreateRasterizerState(
                &D3D11_RASTERIZER_DESC {
                    FillMode: D3D11_FILL_SOLID,
                    CullMode: D3D11_CULL_NONE,
                    DepthClipEnable: true.into(),
                    ..Default::default()
                },
                Some(&mut raster),
            )?;
            Ok(Self {
                size,
                context: context.clone(),
                texture,
                input: input.unwrap(),
                output: output.unwrap(),
                vertex: vertex.unwrap(),
                pixel: pixel.unwrap(),
                sampler: sampler.unwrap(),
                raster: raster.unwrap(),
            })
        }
    }
    pub fn run(&self) -> Result<&ID3D11Texture2D> {
        unsafe {
            self.context.IASetInputLayout(None);
            self.context
                .IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            self.context.VSSetShader(&self.vertex, None);
            self.context.PSSetShader(&self.pixel, None);
            self.context
                .PSSetShaderResources(0, Some(&[Some(self.input.clone())]));
            self.context
                .PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            self.context.RSSetState(&self.raster);
            self.context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                Width: self.size.0 as f32,
                Height: self.size.1 as f32,
                MinDepth: 0.0,
                MaxDepth: 1.0,
                ..Default::default()
            }]));
            self.context
                .OMSetRenderTargets(Some(&[Some(self.output.clone())]), None);
            self.context.OMSetBlendState(None, None, u32::MAX);
            self.context.OMSetDepthStencilState(None, 0);
            self.context.Draw(3, 0);
            // Do not retain capture textures as context bindings across resize/stop.
            self.context.PSSetShaderResources(0, Some(&[None]));
            self.context.OMSetRenderTargets(None, None);
        }
        Ok(&self.texture)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::surface::{readback::Readback, Rotation, TextureFrame};
    use windows::Win32::Graphics::{Direct3D::D3D_DRIVER_TYPE_WARP, Dxgi::Common::*};
    #[test]
    fn gpu_resize_preserves_color_orientation_and_retained_original_on_live_increase() {
        unsafe {
            let mut device = None;
            let mut context = None;
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_WARP,
                Default::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                None,
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            )
            .unwrap();
            let device = device.unwrap();
            let context = context.unwrap();
            let mut pixels = vec![0u8; 64 * 32 * 4];
            for y in 0..32 {
                for x in 0..64 {
                    let i = (y * 64 + x) * 4;
                    pixels[i + if x < 32 { 2 } else { 0 }] = 255;
                    pixels[i + 3] = 255;
                }
            }
            let desc = D3D11_TEXTURE2D_DESC {
                Width: 64,
                Height: 32,
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
            };
            let data = D3D11_SUBRESOURCE_DATA {
                pSysMem: pixels.as_ptr().cast(),
                SysMemPitch: 64 * 4,
                SysMemSlicePitch: 0,
            };
            let mut texture = None;
            device
                .CreateTexture2D(&desc, Some(&data), Some(&mut texture))
                .unwrap();
            let texture = texture.unwrap();
            let mut readback = Readback::default();
            readback
                .copy(&TextureFrame {
                    device: &device,
                    context: &context,
                    texture: &texture,
                    rotation: Rotation::Identity,
                    cursor: None,
                })
                .unwrap();
            for size in [(16, 8), (32, 16), (64, 32)] {
                readback.prepare(size).unwrap();
                assert_eq!(readback.output_size, size, "{:?}", readback.scale_error);
                assert!(readback.scale_error.is_none());
                let mapped = readback.map().unwrap();
                let stride = mapped.stride() as usize;
                let bytes = mapped.bytes();
                let red = stride * 2 + 4;
                let blue = stride * 2 + (size.0 as usize - 2) * 4;
                assert_eq!(&bytes[red..red + 4], &[0, 0, 255, 255]);
                assert_eq!(&bytes[blue..blue + 4], &[255, 0, 0, 255]);
            }
        }
    }
}
