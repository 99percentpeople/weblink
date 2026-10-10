//! Display-only Desktop Duplication. Acquisition and release stay on one worker.
use crate::{
    surface::{Cursor, CursorShape, Rotation, TextureFrame},
    Frames, Result, Session,
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use windows::{
    core::Interface,
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::D3D_DRIVER_TYPE_UNKNOWN,
            Direct3D11::*,
            Dxgi::{Common::*, *},
        },
    },
};

struct Duplication {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    output: IDXGIOutputDuplication,
    rotation: Rotation,
}

struct Finished(Arc<Mutex<Frames>>);
impl Drop for Finished {
    fn drop(&mut self) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).finish();
    }
}
impl Duplication {
    fn open(monitor: Option<usize>) -> Result<Self> {
        unsafe {
            let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| e.to_string())?;
            let mut adapter_index = 0;
            while let Ok(adapter) = factory.EnumAdapters1(adapter_index) {
                adapter_index += 1;
                let mut output_index = 0;
                while let Ok(output) = adapter.EnumOutputs(output_index) {
                    output_index += 1;
                    let desc = output.GetDesc().map_err(|e| e.to_string())?;
                    if !desc.AttachedToDesktop.as_bool()
                        || monitor.is_some_and(|m| m != desc.Monitor.0 as usize)
                    {
                        continue;
                    }
                    let output: IDXGIOutput1 = output.cast().map_err(|e| e.to_string())?;
                    let (mut device, mut context) = (None, None);
                    D3D11CreateDevice(
                        &adapter,
                        D3D_DRIVER_TYPE_UNKNOWN,
                        HMODULE::default(),
                        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                        None,
                        D3D11_SDK_VERSION,
                        Some(&mut device),
                        None,
                        Some(&mut context),
                    )
                    .map_err(|e| e.to_string())?;
                    let device = device.ok_or("No DXGI capture device")?;
                    let context = context.ok_or("No DXGI capture context")?;
                    // Acquisition and the sink's asynchronous GPU readback share
                    // this immediate context. A mutex around CopyResource/Map
                    // alone does not serialize DXGI's internal context access.
                    // Enable D3D protection before creating the duplication.
                    let multithread: ID3D11Multithread = context.cast().map_err(|e| {
                        format!("DXGI capture requires a thread-safe D3D context: {e}")
                    })?;
                    let _ = multithread.SetMultithreadProtected(true);
                    if !multithread.GetMultithreadProtected().as_bool() {
                        return Err("Could not enable DXGI D3D context protection".into());
                    }
                    let duplication = match output.DuplicateOutput(&device) {
                        Ok(duplication) => duplication,
                        Err(_) if monitor.is_none() => continue,
                        Err(error) => {
                            return Err(format!(
                                "Desktop Duplication is unavailable for this display: {error}"
                            ))
                        }
                    };
                    let rotation = match desc.Rotation {
                        DXGI_MODE_ROTATION_ROTATE90 => Rotation::Clockwise90,
                        DXGI_MODE_ROTATION_ROTATE180 => Rotation::Clockwise180,
                        DXGI_MODE_ROTATION_ROTATE270 => Rotation::Clockwise270,
                        _ => Rotation::Identity,
                    };
                    return Ok(Self {
                        device,
                        context,
                        output: duplication,
                        rotation,
                    });
                }
            }
        }
        Err("No display supports Desktop Duplication in this session".into())
    }
    fn run(&self, stop: &AtomicBool, frames: &Mutex<Frames>) -> Result<()> {
        let mut cursor = Cursor::default();
        while !stop.load(Ordering::Acquire) {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;
            // A blocking acquire holds the protected D3D context while waiting
            // for desktop changes, starving Map on the conversion worker.
            // Poll once, then wait outside the graphics API when idle.
            match unsafe { self.output.AcquireNextFrame(0, &mut info, &mut resource) } {
                Ok(()) => {}
                Err(error) if error.code() == DXGI_ERROR_WAIT_TIMEOUT => {
                    thread::sleep(Duration::from_millis(1));
                    continue;
                }
                Err(error) => {
                    return Err(format!(
                        "Desktop Duplication stopped; select the display again: {error}"
                    ))
                }
            }
            // Every successful acquisition is released, including sink/conversion errors.
            let _lease = FrameLease(&self.output);
            let texture: ID3D11Texture2D = resource
                .ok_or("Missing duplicated desktop texture")?
                .cast()
                .map_err(|e| e.to_string())?;
            if info.LastMouseUpdateTime != 0 {
                cursor.visible = info.PointerPosition.Visible.as_bool();
                cursor.x = info.PointerPosition.Position.x;
                cursor.y = info.PointerPosition.Position.y;
            }
            if info.PointerShapeBufferSize > 0 {
                if info.PointerShapeBufferSize > 16 * 1024 * 1024 {
                    return Err("Invalid desktop pointer shape size".into());
                }
                let mut data = vec![0; info.PointerShapeBufferSize as usize];
                let mut required = 0;
                let mut shape = DXGI_OUTDUPL_POINTER_SHAPE_INFO::default();
                unsafe {
                    self.output.GetFramePointerShape(
                        data.len() as u32,
                        data.as_mut_ptr().cast(),
                        &mut required,
                        &mut shape,
                    )
                }
                .map_err(|e| e.to_string())?;
                let kind = match DXGI_OUTDUPL_POINTER_SHAPE_TYPE(shape.Type as i32) {
                    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME => CursorShape::Monochrome,
                    DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR => CursorShape::MaskedColor,
                    _ => CursorShape::Color,
                };
                cursor.shape = kind;
                cursor.width = shape.Width;
                cursor.height = if kind == CursorShape::Monochrome {
                    shape.Height / 2
                } else {
                    shape.Height
                };
                cursor.pitch = shape.Pitch;
                cursor.bytes = Arc::new(data);
            }
            Frames::deliver(
                frames,
                TextureFrame {
                    device: &self.device,
                    context: &self.context,
                    texture: &texture,
                    rotation: self.rotation,
                    cursor: Some(&cursor),
                },
            )?;
        }
        Ok(())
    }
}
struct FrameLease<'a>(&'a IDXGIOutputDuplication);
impl Drop for FrameLease<'_> {
    fn drop(&mut self) {
        let _ = unsafe { self.0.ReleaseFrame() };
    }
}

pub(super) fn supported() -> bool {
    Duplication::open(None).is_ok()
}
pub(super) fn start(monitor: usize, frames: Arc<Mutex<Frames>>) -> Result<Box<dyn Session>> {
    let stop = Arc::new(AtomicBool::new(false));
    let signal = stop.clone();
    let (ready, receiver) = mpsc::sync_channel(1);
    let worker = thread::Builder::new()
        .name("weblink-display-dxgi".into())
        .spawn(move || {
            let duplication = match Duplication::open(Some(monitor)) {
                Ok(duplication) => duplication,
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    return Err(error);
                }
            };
            // Startup errors return to the caller and may trigger WGC fallback
            // with these same frames. Only an opened session can close them.
            // Arm before announcing readiness so even an immediate exit wakes it.
            let _finished = Finished(frames.clone());
            if ready.send(Ok(())).is_err() {
                return Ok(());
            }
            duplication.run(&signal, &frames)
        })
        .map_err(|e| e.to_string())?;
    match receiver.recv() {
        Ok(Ok(())) => Ok(Box::new(DxgiSession {
            stop,
            worker: Some(worker),
        })),
        Ok(Err(error)) => {
            let _ = worker.join();
            Err(error)
        }
        Err(error) => {
            let _ = worker.join();
            Err(error.to_string())
        }
    }
}
struct DxgiSession {
    stop: Arc<AtomicBool>,
    worker: Option<JoinHandle<Result<()>>>,
}
impl DxgiSession {
    fn close(&mut self) -> Result<()> {
        self.stop.store(true, Ordering::Release);
        self.worker.take().map_or(Ok(()), |worker| {
            worker
                .join()
                .map_err(|_| "Desktop Duplication worker panicked".to_string())?
        })
    }
}
impl Session for DxgiSession {
    fn cursor_visibility_supported(&self) -> bool {
        true
    }
    fn set_cursor_visible(&self, _: bool) -> Result<()> {
        // MediaSession hides the separate pointer. Explicit DXGI stays on this
        // path even if Windows embeds a pointer in the texture; only Auto may
        // replace this session with WGC to exclude those pixels as well.
        Ok(())
    }
    fn is_finished(&self) -> bool {
        self.worker.as_ref().is_none_or(|w| w.is_finished())
    }
    fn stop(mut self: Box<Self>) -> Result<()> {
        self.close()
    }
}
impl Drop for DxgiSession {
    fn drop(&mut self) {
        let _ = self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_dxgi_start_leaves_shared_frames_open_for_fallback() {
        let (send, receive) = mpsc::channel();
        let frames = Arc::new(Mutex::new(Frames {
            changed: crate::lifecycle::Changed::new(move || {
                let _ = send.send(());
            }),
            ..Default::default()
        }));
        // A null monitor cannot match an attached display. Failure must be
        // synchronous; an Auto caller can reuse these frames for WGC.
        assert!(start(0, frames.clone()).is_err());
        assert!(!frames.lock().unwrap().closed);
        assert_eq!(receive.try_recv(), Err(mpsc::TryRecvError::Empty));
    }
}
