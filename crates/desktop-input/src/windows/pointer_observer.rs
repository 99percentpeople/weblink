//! Passive movement attribution on the existing input lifecycle listener thread.
use super::safety::Observations;
use crate::input::Error;
use std::{cell::RefCell, sync::Arc};
use windows::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    System::LibraryLoader::GetModuleHandleW,
    UI::WindowsAndMessaging::*,
};

thread_local! {
    static STATE: RefCell<Option<(usize, Arc<Observations>)>> = const { RefCell::new(None) };
}

fn local_movement(flags: u32, extra: usize, marker: usize) -> bool {
    flags & LLMHF_INJECTED == 0 || extra != marker
}

unsafe extern "system" fn hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && wp.0 as u32 == WM_MOUSEMOVE {
        let event = &*(lp.0 as *const MSLLHOOKSTRUCT);
        STATE.with(|slot| {
            if let Some((marker, observations)) = slot.borrow().as_ref() {
                observations.pointer_moved(local_movement(event.flags, event.dwExtraInfo, *marker));
            }
        });
    }
    // Never block input or do capture/network work in the hook.
    CallNextHookEx(None, code, wp, lp)
}

pub(super) struct Listener(HHOOK);
impl Listener {
    pub fn new(marker: usize, observations: Arc<Observations>) -> Result<Self, Error> {
        let hook = unsafe {
            GetModuleHandleW(None).and_then(|module| {
                SetWindowsHookExW(WH_MOUSE_LL, Some(hook), Some(module.into()), 0)
            })
        }
        .map_err(|_| Error::Unavailable)?;
        STATE.with(|slot| *slot.borrow_mut() = Some((marker, observations)));
        Ok(Self(hook))
    }
}
impl Drop for Listener {
    fn drop(&mut self) {
        unsafe {
            let _ = UnhookWindowsHookEx(self.0);
        }
        STATE.with(|slot| slot.borrow_mut().take());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_our_tagged_injections_belong_to_the_viewer() {
        assert!(local_movement(0, 0, 42));
        assert!(local_movement(0, 42, 42));
        assert!(local_movement(LLMHF_INJECTED, 7, 42));
        assert!(!local_movement(LLMHF_INJECTED, 42, 42));
        assert!(!local_movement(
            LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED,
            42,
            42
        ));
    }
}
