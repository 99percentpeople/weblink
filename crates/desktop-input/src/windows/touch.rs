use crate::{
    input::Error,
    touch::{Action, Phase, MAX_CONTACTS},
};
use std::{collections::BTreeMap, thread, time::Duration};
use windows::{
    core::HRESULT,
    Win32::{
        Foundation::{ERROR_NOT_READY, POINT, RECT},
        UI::{
            Controls::*,
            Input::Pointer::*,
            WindowsAndMessaging::{PT_TOUCH, TOUCH_MASK_CONTACTAREA, TOUCH_MASK_PRESSURE},
        },
    },
};

fn touch_info(a: &Action) -> POINTER_TOUCH_INFO {
    let mut info = POINTER_TOUCH_INFO {
        pointerInfo: POINTER_INFO {
            pointerType: PT_TOUCH,
            pointerId: u32::from(a.id),
            ptPixelLocation: POINT { x: a.x, y: a.y },
            pointerFlags: match a.phase {
                Phase::Down => POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT,
                Phase::Update => {
                    POINTER_FLAG_UPDATE | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT
                }
                Phase::Up => POINTER_FLAG_UP,
                Phase::Cancel => POINTER_FLAG_UP | POINTER_FLAG_CANCELED,
            },
            ..Default::default()
        },
        ..Default::default()
    };
    if let Some(pressure) = a.pressure {
        info.touchMask |= TOUCH_MASK_PRESSURE;
        info.pressure = pressure;
    }
    if let Some(area) = a.contact {
        info.touchMask |= TOUCH_MASK_CONTACTAREA;
        info.rcContact = RECT {
            left: area.left,
            top: area.top,
            right: (i64::from(area.left) + i64::from(area.width)) as i32,
            bottom: (i64::from(area.top) + i64::from(area.height)) as i32,
        };
    }
    info
}

/// A dedicated OS device owns only this worker's touch contacts.
pub(super) struct TouchDevice {
    handle: Option<HSYNTHETICPOINTERDEVICE>,
    enabled: bool,
    active: BTreeMap<u8, Action>,
}
impl TouchDevice {
    pub fn new() -> Self {
        let mut result = Self {
            handle: None,
            enabled: false,
            active: BTreeMap::new(),
        };
        result.create();
        result
    }
    fn create(&mut self) {
        self.handle = unsafe {
            CreateSyntheticPointerDevice(PT_TOUCH, MAX_CONTACTS as u32, POINTER_FEEDBACK_NONE)
        }
        .ok();
        self.enabled = self.handle.is_some();
    }
    pub fn supported(&self) -> bool {
        self.enabled
    }
    fn inject(&self, actions: &[Action]) -> Result<(), Error> {
        let handle = self.handle.ok_or(Error::Unavailable)?;
        let frame: Vec<_> = actions
            .iter()
            .map(|a| POINTER_TYPE_INFO {
                r#type: PT_TOUCH,
                Anonymous: POINTER_TYPE_INFO_0 {
                    touchInfo: touch_info(a),
                },
            })
            .collect();
        for attempt in 0..3 {
            match unsafe { InjectSyntheticPointerInput(handle, &frame) } {
                Ok(()) => return Ok(()),
                // The documented timestamp collision means this exact frame was not injected.
                Err(e) if e.code() == HRESULT::from_win32(ERROR_NOT_READY.0) && attempt < 2 => {
                    thread::sleep(Duration::from_millis(1))
                }
                Err(_) => return Err(Error::Injection),
            }
        }
        Err(Error::Injection)
    }
    pub fn submit(&mut self, actions: &[Action]) -> Result<(), Error> {
        if actions.iter().any(|a| a.phase == Phase::Cancel) {
            if actions.iter().any(|a| a.phase != Phase::Cancel) {
                return Err(Error::Invalid);
            }
            return self.cancel();
        }
        if self.handle.is_none() {
            self.create();
        }
        if self.handle.is_none() {
            return Err(Error::Unavailable);
        }
        // An UP must use the last injected coordinate, even if pointerup moved slightly.
        // Send that final movement in a separate frame before releasing the contact.
        if actions.iter().any(|a| {
            a.phase == Phase::Up
                && self
                    .active
                    .get(&a.id)
                    .is_some_and(|p| p.x != a.x || p.y != a.y)
        }) {
            let updates: Vec<_> = self
                .active
                .values()
                .map(|p| {
                    let a = actions.iter().find(|a| a.id == p.id).unwrap_or(p);
                    Action {
                        phase: Phase::Update,
                        // Preserve held pressure until the separate UP frame.
                        pressure: if a.phase == Phase::Up {
                            p.pressure
                        } else {
                            a.pressure
                        },
                        ..*a
                    }
                })
                .collect();
            self.inject(&updates)?;
            for a in updates {
                self.active.insert(a.id, a);
            }
        }
        // Record possible downs before the call, so partial failures also get cleanup.
        for a in actions {
            if a.phase == Phase::Down {
                self.active.insert(a.id, *a);
            }
        }
        self.inject(actions)?;
        for a in actions {
            if a.phase == Phase::Up {
                self.active.remove(&a.id);
            } else {
                self.active.insert(a.id, *a);
            }
        }
        Ok(())
    }
    pub fn cancel(&mut self) -> Result<(), Error> {
        if self.active.is_empty() {
            return Ok(());
        }
        // InjectSyntheticPointerInput can strip CANCELED and deliver an ordinary UP.
        // Removing our dedicated device produces a native canceled UP for every contact,
        // so aborting a gesture cannot accidentally complete a tap or drop.
        self.destroy();
        self.active.clear();
        // Recreate lazily on the next gesture; cleanup itself must only release input.
        Ok(())
    }
    fn destroy(&mut self) {
        if let Some(handle) = self.handle.take() {
            unsafe {
                DestroySyntheticPointerDevice(handle);
            }
        }
    }
}
impl Drop for TouchDevice {
    fn drop(&mut self) {
        self.destroy();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::input::Rect;

    #[test]
    fn touch_injection_masks_only_forwarded_properties_and_keeps_phase_flags() {
        let mut action = Action {
            id: 1,
            x: -500,
            y: 500,
            phase: Phase::Down,
            pressure: None,
            contact: None,
        };
        assert_eq!(touch_info(&action).touchMask, 0);
        action.pressure = Some(256);
        action.contact = Some(Rect {
            left: -510,
            top: 485,
            width: 20,
            height: 30,
        });
        let info = touch_info(&action);
        assert_eq!(info.touchMask, TOUCH_MASK_PRESSURE | TOUCH_MASK_CONTACTAREA);
        assert_eq!(info.pressure, 256);
        assert_eq!(
            (
                info.rcContact.left,
                info.rcContact.top,
                info.rcContact.right,
                info.rcContact.bottom
            ),
            (-510, 485, -490, 515)
        );
        assert_eq!(
            info.pointerInfo.pointerFlags,
            POINTER_FLAG_DOWN | POINTER_FLAG_INRANGE | POINTER_FLAG_INCONTACT
        );
        action.phase = Phase::Up;
        action.pressure = Some(0);
        let info = touch_info(&action);
        assert_eq!(info.pointerInfo.pointerFlags, POINTER_FLAG_UP);
        assert_eq!(info.pressure, 0);
        assert_ne!(info.touchMask & TOUCH_MASK_PRESSURE, 0);
    }
}
