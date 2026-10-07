//! Precision touchpad injection, resolved dynamically because older Windows
//! builds do not export CreateSyntheticPointerDevice2. There is no wheel fallback.
use crate::{input::Error, pan::Pan};
use std::{ffi::c_void, time::Instant};
use windows::{
    core::{s, w, BOOL},
    Win32::{
        Foundation::POINT,
        System::LibraryLoader::{GetModuleHandleW, GetProcAddress},
        UI::{Controls::*, Input::Pointer::*, WindowsAndMessaging::*},
    },
};

// These documented Win32 declarations are not yet in windows-rs 0.62.
// https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-synthetic_device_creation_params
#[repr(C)]
struct CreationParams {
    pointer_type: POINTER_INPUT_TYPE,
    max_count: u32,
    feedback_mode: POINTER_FEEDBACK_MODE,
    monitor: *mut c_void,
    width: u32,
    height: u32,
    options: u32,
}
type Create = unsafe extern "system" fn(*const CreationParams) -> HSYNTHETICPOINTERDEVICE;
type TouchpadAction = unsafe extern "system" fn(HSYNTHETICPOINTERDEVICE, i32) -> BOOL;

#[derive(Clone, Copy)]
struct Api {
    create: Create,
    action: TouchpadAction,
}
impl Api {
    fn load() -> Option<Self> {
        unsafe {
            let module = GetModuleHandleW(w!("user32.dll")).ok()?;
            Some(Self {
                create: std::mem::transmute::<unsafe extern "system" fn() -> isize, Create>(
                    GetProcAddress(module, s!("CreateSyntheticPointerDevice2"))?,
                ),
                action: std::mem::transmute::<unsafe extern "system" fn() -> isize, TouchpadAction>(
                    GetProcAddress(module, s!("InjectTouchpadAction"))?,
                ),
            })
        }
    }
    fn create(self) -> Option<HSYNTHETICPOINTERDEVICE> {
        let params = CreationParams {
            pointer_type: PT_TOUCHPAD,
            max_count: 2,
            feedback_mode: POINTER_FEEDBACK_NONE,
            monitor: std::ptr::null_mut(),
            // A virtual surface large enough for a full mobile swipe at maximum speed.
            // Units are 1/100 mm; scale is independent of display/video resolution.
            width: 120_000,
            height: 120_000,
            options: 1 | 2, // SDCO_PHYSICAL_SIZE | SDCO_TOUCHPAD_GESTURE_ONLY
        };
        let handle = unsafe { (self.create)(&params) };
        (!handle.0.is_null()).then_some(handle)
    }
}

fn direction() -> Result<f64, Error> {
    // TOUCHPAD_PARAMETERS_V1: three DWORDs, two flag DWORDs, six setting DWORDs.
    // Query rather than altering the host's global natural-scroll preference.
    let mut params = [0u32; 11];
    params[0] = 1;
    unsafe {
        SystemParametersInfoW(
            SYSTEM_PARAMETERS_INFO_ACTION(0x00ae),
            std::mem::size_of_val(&params) as u32,
            Some(params.as_mut_ptr().cast()),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        )
    }
    .map_err(|_| Error::Unavailable)?;
    Ok(if params[4] & (1 << 9) != 0 { -1.0 } else { 1.0 })
}

pub(super) struct PanDevice {
    api: Option<Api>,
    handle: Option<HSYNTHETICPOINTERDEVICE>,
    supported: bool,
    active: bool,
    used: bool,
    position: (i32, i32),
    scale: f64,
    direction: f64,
    clock: Instant,
    timestamp: u32,
}
impl PanDevice {
    pub fn new() -> Self {
        let api = Api::load();
        let handle = api.and_then(Api::create);
        let supported = handle.is_some() && direction().is_ok();
        Self {
            api,
            handle,
            supported,
            active: false,
            used: false,
            position: (0, 0),
            scale: 1.0,
            direction: 1.0,
            clock: Instant::now(),
            timestamp: 0,
        }
    }
    pub fn supported(&self) -> bool {
        self.supported
    }
    fn inject(&mut self, down: bool) -> Result<(), Error> {
        let handle = self.handle.ok_or(Error::Unavailable)?;
        self.timestamp =
            (self.clock.elapsed().as_millis() as u32).max(self.timestamp.saturating_add(1));
        let locations = contact_locations(self.position, self.scale);
        let frame = [0, 1].map(|id| POINTER_TYPE_INFO {
            r#type: PT_TOUCHPAD,
            Anonymous: POINTER_TYPE_INFO_0 {
                touchInfo: POINTER_TOUCH_INFO {
                    pointerInfo: POINTER_INFO {
                        pointerType: PT_TOUCHPAD,
                        pointerId: id,
                        ptHimetricLocation: POINT {
                            x: locations[id as usize].0,
                            y: locations[id as usize].1,
                        },
                        // Touchpad transitions are inferred from contact presence by Windows.
                        pointerFlags: POINTER_FLAG_CONFIDENCE
                            | if down {
                                POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT
                            } else {
                                POINTER_FLAGS(0)
                            },
                        dwTime: self.timestamp,
                        ..Default::default()
                    },
                    ..Default::default()
                },
            },
        });
        unsafe { InjectSyntheticPointerInput(handle, &frame) }.map_err(|_| Error::Injection)
    }
    pub fn submit(&mut self, event: Pan) -> Result<(), Error> {
        if !event.valid() {
            return Err(Error::Invalid);
        }
        match event {
            Pan::Start if !self.active => {
                self.cancel()?;
                self.direction = direction()?;
                self.handle = self.api.and_then(Api::create);
                if self.handle.is_none() {
                    return Err(Error::Unavailable);
                }
                self.position = (0, 0);
                self.scale = 1.0;
                self.clock = Instant::now();
                self.timestamp = 0;
                self.active = true;
                self.used = true; // Cleanup also covers a partially injected start.
                self.inject(true)
            }
            Pan::Update { x, y, scale } if self.active => {
                let displacement_scale = 2540.0 / 96.0 * self.direction;
                self.position = (
                    (x * displacement_scale).round() as i32,
                    (y * displacement_scale).round() as i32,
                );
                // Scroll direction changes translation only, never pinch direction.
                self.scale = scale;
                self.inject(true)
            }
            Pan::End if self.active => {
                self.inject(false)?;
                self.active = false;
                Ok(())
            }
            Pan::Cancel => self.cancel(),
            _ => Err(Error::Invalid),
        }
    }
    pub fn cancel(&mut self) -> Result<(), Error> {
        // End inertia even after the contacts have lifted. Destroying our own
        // device cancels any remaining contacts without producing a tap/click.
        if let Some(handle) = self.handle.take() {
            if self.used {
                if let Some(api) = self.api {
                    unsafe {
                        let _ = (api.action)(handle, 10);
                    } // TA_INERTIA_END
                }
            }
            unsafe { DestroySyntheticPointerDevice(handle) };
        }
        self.active = false;
        self.used = false;
        Ok(())
    }
}

fn contact_locations(position: (i32, i32), scale: f64) -> [(i32, i32); 2] {
    // Start 20 mm apart and vary the span around the same centroid. Windows
    // recognizes native zoom from relative contact distance, including pure pinch.
    let radius = (1_000.0 * scale).round() as i32;
    [-1, 1].map(|side| (60_000 + position.0 + side * radius, 60_000 + position.1))
}

#[cfg(test)]
mod tests {
    use super::contact_locations;

    #[test]
    fn pinch_changes_span_without_moving_the_centroid() {
        for scale in [0.1, 0.5, 1.0, 2.0, 4.0] {
            let [(left, y1), (right, y2)] = contact_locations((120, -80), scale);
            assert_eq!((left + right) / 2, 60_120);
            assert_eq!((y1, y2), (59_920, 59_920));
            assert_eq!(right - left, (2_000.0 * scale) as i32);
        }
    }

    #[test]
    fn maximum_pan_and_pinch_stay_inside_the_synthetic_surface() {
        for x in [-2048.0_f64, 2048.0] {
            for y in [-2048.0_f64, 2048.0] {
                let position = (
                    (x * 2540.0 / 96.0).round() as i32,
                    (y * 2540.0 / 96.0).round() as i32,
                );
                for (x, y) in contact_locations(position, 4.0) {
                    assert!((0..120_000).contains(&x));
                    assert!((0..120_000).contains(&y));
                }
            }
        }
    }
}
impl Drop for PanDevice {
    fn drop(&mut self) {
        let _ = self.cancel();
    }
}
