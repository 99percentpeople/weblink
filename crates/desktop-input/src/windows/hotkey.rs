use super::safety::Observations;
use crate::{input::Error, shortcut::Shortcut, shortcut_observer::ShortcutObserver};
use std::{cell::RefCell, sync::Arc};
use windows::Win32::{
    Foundation::*,
    System::LibraryLoader::GetModuleHandleW,
    UI::{Input::KeyboardAndMouse::GetAsyncKeyState, WindowsAndMessaging::*},
};

struct State {
    keys: ShortcutObserver,
    observations: Arc<Observations>,
}
thread_local! {
    static STATE: RefCell<Option<State>> = const { RefCell::new(None) };
}

unsafe extern "system" fn hook(code: i32, wp: WPARAM, lp: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32
        && matches!(
            wp.0 as u32,
            WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP
        )
    {
        let event = &*(lp.0 as *const KBDLLHOOKSTRUCT);
        // Normalize generic modifier messages while keeping left/right releases independent.
        let vk = match event.vkCode {
            0x10 => {
                if event.scanCode == 0x36 {
                    0xa1
                } else {
                    0xa0
                }
            }
            0x11 => {
                if event.flags.contains(LLKHF_EXTENDED) {
                    0xa3
                } else {
                    0xa2
                }
            }
            0x12 => {
                if event.flags.contains(LLKHF_EXTENDED) {
                    0xa5
                } else {
                    0xa4
                }
            }
            vk => vk,
        };
        STATE.with(|slot| {
            if let Some(state) = slot.borrow_mut().as_mut() {
                let epoch = state.observations.grant_epoch();
                if state.keys.input(
                    vk,
                    !event.flags.contains(LLKHF_UP),
                    event.flags.contains(LLKHF_INJECTED),
                    epoch != 0,
                ) {
                    state.observations.emergency(epoch);
                }
            }
        });
    }
    // This observer never consumes even the matching chord; other apps keep their input.
    CallNextHookEx(None, code, wp, lp)
}

pub(super) struct Listener(HHOOK);
impl Listener {
    pub fn new(shortcut: Shortcut, observations: Arc<Observations>) -> Result<Self, Error> {
        let mut held = [false; 256];
        for (vk, down) in held.iter_mut().enumerate() {
            *down = unsafe { GetAsyncKeyState(vk as i32) } < 0;
        }
        let hook = unsafe {
            GetModuleHandleW(None).and_then(|module| {
                SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), Some(module.into()), 0)
            })
        }
        .map_err(|_| Error::Unavailable)?;
        STATE.with(|slot| {
            *slot.borrow_mut() = Some(State {
                keys: ShortcutObserver::new(shortcut, held),
                observations,
            })
        });
        Ok(Self(hook))
    }
    pub fn configure(&mut self, shortcut: Shortcut) -> Result<(), Error> {
        STATE.with(|slot| {
            let mut slot = slot.borrow_mut();
            let state = slot.as_mut().ok_or(Error::Closed)?;
            state.keys.configure(shortcut);
            Ok(())
        })
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
    use std::{sync::mpsc, thread, time::Duration};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, HOT_KEY_MODIFIERS, MOD_NOREPEAT,
    };

    #[test]
    #[ignore = "briefly reserves a test chord on the interactive Windows desktop; sends no input"]
    fn passive_listeners_coexist_with_another_owners_registered_shortcut() {
        let shortcut: Shortcut = "ctrl-alt-shift-meta-f8".to_owned().try_into().unwrap();
        let (ready, initialized) = mpsc::sync_channel(1);
        let (stop, stopping) = mpsc::sync_channel::<()>(1);
        let other = thread::spawn(move || {
            struct Reserved;
            impl Drop for Reserved {
                fn drop(&mut self) {
                    unsafe {
                        let _ = UnregisterHotKey(None, 0x574c);
                    }
                }
            }
            unsafe {
                RegisterHotKey(
                    None,
                    0x574c,
                    HOT_KEY_MODIFIERS(shortcut.modifiers) | MOD_NOREPEAT,
                    shortcut.vk,
                )
                .unwrap();
            }
            let _reserved = Reserved;
            let _listener = Listener::new(shortcut, Arc::new(Observations::new())).unwrap();
            ready.send(()).unwrap();
            loop {
                super::super::safety::pump();
                match stopping.recv_timeout(Duration::from_millis(5)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            }
        });
        initialized.recv_timeout(Duration::from_secs(5)).unwrap();
        let mut listener = Listener::new(shortcut, Arc::new(Observations::new())).unwrap();
        listener
            .configure("ctrl-shift-f9".to_owned().try_into().unwrap())
            .unwrap();
        listener.configure(shortcut).unwrap();
        // Our listener did not take or release the existing application's registration.
        assert!(unsafe {
            RegisterHotKey(
                None,
                0x574d,
                HOT_KEY_MODIFIERS(shortcut.modifiers) | MOD_NOREPEAT,
                shortcut.vk,
            )
        }
        .is_err());
        drop(listener);
        drop(stop);
        other.join().unwrap();
    }
}
