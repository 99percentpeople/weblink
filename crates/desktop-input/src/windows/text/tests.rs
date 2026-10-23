use super::*;
use windows::core::w;
use windows::Win32::UI::Controls::{EM_SETSEL, EM_UNDO};

struct Editor(HWND);
impl Editor {
    fn new(class: windows::core::PCWSTR, style: WINDOW_STYLE) -> Self {
        Self(unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                class,
                w!(""),
                style,
                0,
                0,
                100,
                100,
                None,
                None,
                None,
                None,
            )
            .unwrap()
        })
    }
    fn text(&self) -> String {
        let mut text = [0u16; 512];
        let length = unsafe { GetWindowTextW(self.0, &mut text) };
        String::from_utf16(&text[..length as usize]).unwrap()
    }
}
impl Drop for Editor {
    fn drop(&mut self) {
        unsafe {
            DestroyWindow(self.0).unwrap();
        }
    }
}

#[test]
fn native_edit_inserts_at_selection_and_preserves_unicode_and_undo() {
    let editor = Editor::new(w!("EDIT"), WINDOW_STYLE(ES_MULTILINE as u32));
    assert!(editable(editor.0));
    replace(editor.0, "prefix suffix").unwrap();
    unsafe {
        SendMessageW(editor.0, EM_SETSEL, Some(WPARAM(7)), Some(LPARAM(7)));
    }
    replace(editor.0, "中😀𝄞e\u{301}").unwrap();
    assert_eq!(editor.text(), "prefix 中😀𝄞e\u{301}suffix");
    unsafe {
        SendMessageW(editor.0, EM_UNDO, None, None);
    }
    assert_eq!(editor.text(), "prefix suffix");
    unsafe {
        SendMessageW(editor.0, EM_SETSEL, Some(WPARAM(0)), Some(LPARAM(6)));
    }
    replace(editor.0, "new").unwrap();
    assert_eq!(editor.text(), "new suffix");
}

#[test]
fn readonly_disabled_and_unrelated_controls_do_not_opt_in() {
    let readonly = Editor::new(w!("EDIT"), WINDOW_STYLE(ES_READONLY as u32));
    let disabled = Editor::new(w!("EDIT"), WS_DISABLED);
    let other = Editor::new(w!("STATIC"), WINDOW_STYLE(0));
    assert!(!editable(readonly.0));
    assert!(!editable(disabled.0));
    assert!(!editable(other.0));
    assert!(readonly.text().is_empty());
    assert!(disabled.text().is_empty());
}
