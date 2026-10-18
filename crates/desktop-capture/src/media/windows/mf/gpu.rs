//! Shared H.264/H.265 GPU input. Raw desktop pixels never enter CPU memory here.
use crate::{
    damage::Damage,
    media::MediaOptions,
    surface::{
        gpu::{ContextLock, Lease, Pool, Wake},
        Cursor, CursorShape, Rotation, TextureFrame,
    },
};
use std::sync::{Arc, OnceLock, Weak};
use windows::{
    core::{s, Interface, Result, PCSTR},
    Win32::Graphics::{
        Direct3D::{Fxc::D3DCompile, ID3DInclude, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST},
        Direct3D11::*,
        Dxgi::Common::*,
    },
};

pub(crate) struct Image {
    pub texture: ID3D11Texture2D,
    view: ID3D11ShaderResourceView,
}
pub(crate) struct Captured {
    pub device: ID3D11Device,
    pub context: ID3D11DeviceContext,
    image: Lease<Image>,
    size: (u32, u32),
    rotation: Rotation,
    cursor: Option<Cursor>,
    damage: Damage,
}
impl Captured {
    pub(super) fn damage(&self, output: (u32, u32)) -> Damage {
        self.damage.for_output(self.size, self.rotation, output)
    }
    pub fn size(&self) -> (u32, u32) {
        match self.rotation {
            Rotation::Clockwise90 | Rotation::Clockwise270 => (self.size.1, self.size.0),
            _ => self.size,
        }
    }
}
pub(crate) struct CapturePool {
    device: ID3D11Device,
    size: (u32, u32),
    pool: Arc<Pool<Image>>,
}
impl CapturePool {
    pub fn matches(&self, frame: &TextureFrame<'_>) -> bool {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            frame.texture.GetDesc(&mut desc);
        }
        self.device == *frame.device && self.size == (desc.Width, desc.Height)
    }
    pub fn new(frame: &TextureFrame<'_>, wake: Wake) -> Self {
        let mut desc = D3D11_TEXTURE2D_DESC::default();
        unsafe {
            frame.texture.GetDesc(&mut desc);
        }
        Self {
            device: frame.device.clone(),
            size: (desc.Width, desc.Height),
            pool: Pool::new(4, wake),
        }
    }
    pub fn capture(&self, frame: &TextureFrame<'_>, cursor: bool) -> Result<Option<Arc<Captured>>> {
        let Some(image) = self.pool.take(|| unsafe {
            let mut desc = D3D11_TEXTURE2D_DESC::default();
            frame.texture.GetDesc(&mut desc);
            desc.Usage = D3D11_USAGE_DEFAULT;
            desc.CPUAccessFlags = 0;
            desc.MiscFlags = 0;
            desc.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
            let mut texture = None;
            frame
                .device
                .CreateTexture2D(&desc, None, Some(&mut texture))?;
            let texture = texture.unwrap();
            let mut view = None;
            frame
                .device
                .CreateShaderResourceView(&texture, None, Some(&mut view))?;
            Ok(Image {
                texture,
                view: view.unwrap(),
            })
        })?
        else {
            return Ok(None);
        };
        // The caller owns the retained source lock until this copy is enqueued.
        unsafe {
            frame.context.CopyResource(&image.texture, frame.texture);
        }
        Ok(Some(Arc::new(Captured {
            device: frame.device.clone(),
            context: frame.context.clone(),
            image,
            size: self.size,
            rotation: frame.rotation,
            cursor: frame.cursor.filter(|c| cursor && c.visible).cloned(),
            damage: Damage::from_rects(frame.dirty_regions, self.size),
        })))
    }
}

pub(crate) struct Surface {
    pub texture: ID3D11Texture2D,
    y: ID3D11RenderTargetView,
    uv: ID3D11RenderTargetView,
}
pub(super) struct Converter {
    pub device: ID3D11Device,
    size: (u32, u32),
    vertex: ID3D11VertexShader,
    y: ID3D11PixelShader,
    uv: ID3D11PixelShader,
    sampler: ID3D11SamplerState,
    raster: ID3D11RasterizerState,
    constants: ID3D11Buffer,
    pool: Arc<Pool<Surface>>,
    cached: Option<(Weak<Captured>, Arc<Lease<Surface>>)>,
    cursor: Option<(Cursor, ID3D11ShaderResourceView)>,
}
fn bytecode(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>> {
    let source = include_str!("gpu.hlsl");
    unsafe {
        let mut blob = None;
        let mut errors = None;
        D3DCompile(
            source.as_ptr().cast(),
            source.len(),
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
        let blob = blob.unwrap();
        Ok(
            std::slice::from_raw_parts(blob.GetBufferPointer().cast(), blob.GetBufferSize())
                .to_vec(),
        )
    }
}
impl Converter {
    pub fn new(device: &ID3D11Device, size: (u32, u32), wake: Wake) -> Result<Self> {
        static SHADERS: OnceLock<Result<[Vec<u8>; 3]>> = OnceLock::new();
        let code = SHADERS
            .get_or_init(|| {
                Ok([
                    bytecode(s!("vs"), s!("vs_4_0"))?,
                    bytecode(s!("psY"), s!("ps_4_0"))?,
                    bytecode(s!("psUV"), s!("ps_4_0"))?,
                ])
            })
            .as_ref()
            .map_err(Clone::clone)?;
        unsafe {
            let mut vertex = None;
            device.CreateVertexShader(&code[0], None, Some(&mut vertex))?;
            let mut y = None;
            device.CreatePixelShader(&code[1], None, Some(&mut y))?;
            let mut uv = None;
            device.CreatePixelShader(&code[2], None, Some(&mut uv))?;
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
            let mut constants = None;
            device.CreateBuffer(
                &D3D11_BUFFER_DESC {
                    ByteWidth: 64,
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut constants),
            )?;
            let converter = Self {
                device: device.clone(),
                size,
                vertex: vertex.unwrap(),
                y: y.unwrap(),
                uv: uv.unwrap(),
                sampler: sampler.unwrap(),
                raster: raster.unwrap(),
                constants: constants.unwrap(),
                pool: Pool::new(8, wake),
                cached: None,
                cursor: None,
            };
            // Probe the actual NV12 plane views before replacing the working CPU path.
            drop(converter.pool.take(|| converter.surface())?);
            Ok(converter)
        }
    }
    fn surface(&self) -> Result<Surface> {
        unsafe {
            let device: ID3D11Device3 = self.device.cast()?;
            let mut texture = None;
            self.device.CreateTexture2D(
                &D3D11_TEXTURE2D_DESC {
                    Width: self.size.0,
                    Height: self.size.1,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_NV12,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: (D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE).0 as u32,
                    ..Default::default()
                },
                None,
                Some(&mut texture),
            )?;
            let texture = texture.unwrap();
            let view = |format, plane| -> Result<ID3D11RenderTargetView> {
                let mut output = None;
                device.CreateRenderTargetView1(
                    &texture,
                    Some(&D3D11_RENDER_TARGET_VIEW_DESC1 {
                        Format: format,
                        ViewDimension: D3D11_RTV_DIMENSION_TEXTURE2D,
                        Anonymous: D3D11_RENDER_TARGET_VIEW_DESC1_0 {
                            Texture2D: D3D11_TEX2D_RTV1 {
                                MipSlice: 0,
                                PlaneSlice: plane,
                            },
                        },
                    }),
                    Some(&mut output),
                )?;
                output.unwrap().cast()
            };
            Ok(Surface {
                y: view(DXGI_FORMAT_R8_UNORM, 0)?,
                uv: view(DXGI_FORMAT_R8G8_UNORM, 1)?,
                texture,
            })
        }
    }
    pub fn matches(&self, frame: &Captured, size: (u32, u32)) -> bool {
        self.device == frame.device && self.size == size
    }
    pub fn convert(
        &mut self,
        frame: &Arc<Captured>,
        options: &MediaOptions,
    ) -> Result<Option<Arc<Lease<Surface>>>> {
        if let Some((source, surface)) = &self.cached {
            if source
                .upgrade()
                .is_some_and(|source| Arc::ptr_eq(&source, frame))
            {
                return Ok(Some(surface.clone()));
            }
        }
        self.cached = None;
        let Some(surface) = self.pool.take(|| self.surface())? else {
            return Ok(None);
        };
        let color = options.color_space().rtc();
        let (kr, kb) = if color.matrix == 1 {
            (0.2126, 0.0722)
        } else {
            (0.299, 0.114)
        };
        let size = frame.size();
        let rotation = match frame.rotation {
            Rotation::Identity => 0.,
            Rotation::Clockwise90 => 1.,
            Rotation::Clockwise180 => 2.,
            Rotation::Clockwise270 => 3.,
        };
        let mut values = [
            self.size.0 as f32,
            self.size.1 as f32,
            size.0 as f32,
            size.1 as f32,
            kr,
            kb,
            if color.full_range { 1. } else { 219. / 255. },
            if color.full_range { 0. } else { 16. / 255. },
            0.,
            0.,
            0.,
            0.,
            rotation,
            0.,
            if color.full_range { 1. } else { 224. / 255. },
            0.,
        ];
        let pointer = if let Some(cursor) = frame.cursor.as_ref() {
            values[8..12].copy_from_slice(&[
                cursor.x as f32,
                cursor.y as f32,
                cursor.width as f32,
                cursor.height as f32,
            ]);
            values[13] = match cursor.shape {
                CursorShape::Color => 1.,
                CursorShape::MaskedColor => 2.,
                CursorShape::Monochrome => 3.,
            };
            // Pointer movement changes position, not its bitmap. Upload only a new
            // shape; the captured desktop stays entirely on the GPU.
            if self.cursor.as_ref().is_none_or(|(cached, _)| {
                !Arc::ptr_eq(&cached.bytes, &cursor.bytes)
                    || (cached.width, cached.height, cached.pitch, cached.shape)
                        != (cursor.width, cursor.height, cursor.pitch, cursor.shape)
            }) {
                self.cursor = Some((cursor.clone(), cursor_view(&self.device, cursor)?));
            }
            Some(self.cursor.as_ref().unwrap().1.clone())
        } else {
            None
        };
        let context = &frame.context;
        let _guard = ContextLock::enter(context)?;
        unsafe {
            context.UpdateSubresource(&self.constants, 0, None, values.as_ptr().cast(), 0, 0);
            context.IASetInputLayout(None);
            context.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
            context.VSSetShader(&self.vertex, None);
            context.PSSetConstantBuffers(0, Some(&[Some(self.constants.clone())]));
            context.PSSetShaderResources(0, Some(&[Some(frame.image.view.clone()), pointer]));
            context.PSSetSamplers(0, Some(&[Some(self.sampler.clone())]));
            context.RSSetState(&self.raster);
            context.OMSetBlendState(None, None, u32::MAX);
            context.OMSetDepthStencilState(None, 0);
            for (div, target, shader) in [(1, &surface.y, &self.y), (2, &surface.uv, &self.uv)] {
                context.RSSetViewports(Some(&[D3D11_VIEWPORT {
                    Width: (self.size.0 / div) as f32,
                    Height: (self.size.1 / div) as f32,
                    MinDepth: 0.,
                    MaxDepth: 1.,
                    ..Default::default()
                }]));
                context.OMSetRenderTargets(Some(&[Some(target.clone())]), None);
                context.PSSetShader(shader, None);
                context.Draw(3, 0);
            }
            context.PSSetShaderResources(0, Some(&[None, None]));
            context.PSSetConstantBuffers(0, Some(&[None]));
            context.OMSetRenderTargets(None, None);
            context.Flush();
            self.device.GetDeviceRemovedReason()?;
        }
        let surface = Arc::new(surface);
        self.cached = Some((Arc::downgrade(frame), surface.clone()));
        Ok(Some(surface))
    }
}
fn cursor_view(device: &ID3D11Device, cursor: &Cursor) -> Result<ID3D11ShaderResourceView> {
    use windows::Win32::Foundation::E_INVALIDARG;
    let (width, height, pitch) = (
        cursor.width as usize,
        cursor.height as usize,
        cursor.pitch as usize,
    );
    if width == 0 || height == 0 || width > 2048 || height > 2048 {
        return Err(E_INVALIDARG.into());
    }
    let mut expanded = Vec::new();
    let (bytes, stride) = if cursor.shape == CursorShape::Monochrome {
        if pitch < width.div_ceil(8) || cursor.bytes.len() < pitch * height * 2 {
            return Err(E_INVALIDARG.into());
        }
        expanded.resize(width * height * 4, 0);
        for y in 0..height {
            for x in 0..width {
                let bit = 0x80 >> (x % 8);
                let offset = y * pitch + x / 8;
                expanded[(y * width + x) * 4 + 2] = if cursor.bytes[offset] & bit != 0 {
                    255
                } else {
                    0
                };
                expanded[(y * width + x) * 4 + 1] =
                    if cursor.bytes[offset + pitch * height] & bit != 0 {
                        255
                    } else {
                        0
                    };
            }
        }
        (&expanded[..], width * 4)
    } else {
        if pitch < width * 4 || cursor.bytes.len() < pitch * height {
            return Err(E_INVALIDARG.into());
        }
        (&cursor.bytes[..], pitch)
    };
    unsafe {
        let mut texture = None;
        device.CreateTexture2D(
            &D3D11_TEXTURE2D_DESC {
                Width: width as u32,
                Height: height as u32,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_IMMUTABLE,
                BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                ..Default::default()
            },
            Some(&D3D11_SUBRESOURCE_DATA {
                pSysMem: bytes.as_ptr().cast(),
                SysMemPitch: stride as u32,
                SysMemSlicePitch: 0,
            }),
            Some(&mut texture),
        )?;
        let mut view = None;
        device.CreateShaderResourceView(&texture.unwrap(), None, Some(&mut view))?;
        Ok(view.unwrap())
    }
}

#[cfg(test)]
mod tests;
