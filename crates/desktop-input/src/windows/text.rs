//! Committed text for native Unicode editors. Rapid VK_PACKET input can be
//! corrupted by modern RichEdit/Notepad's keyboard/IME translation. EM_REPLACESEL
//! inserts the bounded frame at the caret (or selection) and retains undo.
use crate::{input::Error, window::BoundWindow};
use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    System::Threading::GetCurrentProcessId,
    UI::{
        Controls::EM_REPLACESEL, Input::KeyboardAndMouse::IsWindowEnabled, WindowsAndMessaging::*,
    },
};

#[derive(Clone, Copy, PartialEq, Eq)]
struct Focus {
    root: HWND,
    editor: HWND,
    thread: u32,
    editor_thread: u32,
    process: u32,
}
impl Focus {
    fn current() -> Result<Self, Error> {
        unsafe {
            let root = GetForegroundWindow();
            let mut process = 0;
            let thread = GetWindowThreadProcessId(root, Some(&mut process));
            let mut info = GUITHREADINFO {
                cbSize: std::mem::size_of::<GUITHREADINFO>() as u32,
                ..Default::default()
            };
            if root.is_invalid() || thread == 0 || GetGUIThreadInfo(thread, &mut info).is_err() {
                return Err(Error::WindowUnavailable);
            }
            let editor = info.hwndFocus;
            if editor.is_invalid() || GetAncestor(editor, GA_ROOT) != root {
                return Err(Error::WindowFocusLost);
            }
            let mut editor_process = 0;
            let editor_thread = GetWindowThreadProcessId(editor, Some(&mut editor_process));
            if editor_thread == 0 || editor_process != process {
                return Err(Error::WindowUnavailable);
            }
            Ok(Self {
                root,
                editor,
                thread,
                editor_thread,
                process,
            })
        }
    }
}

fn editable(editor: HWND) -> bool {
    unsafe {
        let mut class = [0u16; 128];
        let count = GetClassNameW(editor, &mut class);
        let class = String::from_utf16_lossy(&class[..count.max(0) as usize]);
        // Only known native Unicode edit classes implement the message contract.
        // Do not guess support for arbitrary application/browser HWNDs.
        matches!(
            class.as_str(),
            "Edit" | "RichEdit20W" | "RICHEDIT50W" | "RichEditD2DPT"
        ) && IsWindowUnicode(editor).as_bool()
            && IsWindowEnabled(editor).as_bool()
            && GetWindowLongPtrW(editor, GWL_STYLE) & ES_READONLY as isize == 0
    }
}

fn replace(editor: HWND, text: &str) -> Result<(), Error> {
    let text: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    let mut result = 0;
    // This system message (< WM_USER) marshals the string across processes.
    // Keep the worker bounded, including a hung recipient. A timeout may already
    // have inserted text: never replay it using keyboard injection.
    let sent = unsafe {
        SendMessageTimeoutW(
            editor,
            EM_REPLACESEL,
            WPARAM(1),
            LPARAM(text.as_ptr() as isize),
            SMTO_ABORTIFHUNG | SMTO_BLOCK | SMTO_ERRORONEXIT,
            400,
            Some(&mut result),
        )
    };
    if sent.0 == 0 {
        Err(Error::WindowUnavailable)
    } else {
        Ok(())
    }
}

pub(super) fn insert(
    text: &str,
    window: Option<&BoundWindow>,
    available: impl Fn() -> bool,
) -> Result<bool, Error> {
    let Ok(focus) = Focus::current() else {
        return Ok(false);
    };
    // Cross-process system messages copy the string. In-process delivery could
    // retain our pointer after a timeout, or ignore the timeout on the same queue.
    if focus.process == unsafe { GetCurrentProcessId() } || !editable(focus.editor) {
        return Ok(false);
    }
    if !available() {
        return Err(Error::Unavailable);
    }
    if let Some(window) = window {
        window.check(None)?;
    }
    if Focus::current()? != focus {
        return Err(Error::WindowFocusLost);
    }
    if !editable(focus.editor) {
        return Err(Error::WindowUnavailable);
    }
    replace(focus.editor, text)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
