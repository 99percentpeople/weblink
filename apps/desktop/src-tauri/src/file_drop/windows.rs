//! One-shot OLE drop. No clipboard mutation, synthetic paste, or system mouse button injection.
use std::{
    cell::Cell,
    time::{Duration, Instant},
};
use windows::{
    core::{implement, BOOL, HRESULT, PCWSTR},
    Win32::{
        Foundation::{
            DRAGDROP_S_CANCEL, DRAGDROP_S_DROP, DRAGDROP_S_USEDEFAULTCURSORS, E_FAIL, HWND, LPARAM,
            POINT, RECT, S_OK, WPARAM,
        },
        Graphics::Gdi::ScreenToClient,
        System::{
            Com::IDataObject,
            Ole::{
                DoDragDrop, IDropSource, IDropSource_Impl, OleInitialize, OleUninitialize,
                DROPEFFECT, DROPEFFECT_COPY, DROPEFFECT_NONE,
            },
            SystemServices::{MK_LBUTTON, MODIFIERKEYS_FLAGS},
            Threading::GetCurrentThreadId,
        },
        UI::{
            HiDpi::{
                SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT,
                DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            },
            Input::KeyboardAndMouse::GetCapture,
            Shell::{
                BHID_DataObject, ILCreateFromPathW, ILFree, SHCreateShellItemArrayFromIDLists,
            },
            WindowsAndMessaging::{
                GetAncestor, GetCursorPos, GetWindowRect, GetWindowThreadProcessId, KillTimer,
                PostMessageW, PostThreadMessageW, SetCursorPos, SetTimer, WindowFromPoint, GA_ROOT,
                WM_LBUTTONUP, WM_MOUSEMOVE,
            },
        },
    },
};

struct Dpi(DPI_AWARENESS_CONTEXT);
impl Dpi {
    fn enter() -> Result<Self, String> {
        let previous =
            unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
        if previous.0.is_null() {
            Err("Physical drop coordinates unavailable".into())
        } else {
            Ok(Self(previous))
        }
    }
}
impl Drop for Dpi {
    fn drop(&mut self) {
        unsafe {
            SetThreadDpiAwarenessContext(self.0);
        }
    }
}
#[derive(Clone)]
pub struct Destination {
    point: (i32, i32),
    window: usize,
    root: usize,
    process: u32,
    thread: u32,
    rect: (i32, i32, i32, i32),
}
impl Destination {
    pub fn capture(point: (i32, i32)) -> Result<Self, String> {
        let _dpi = Dpi::enter()?;
        unsafe {
            let hwnd = WindowFromPoint(POINT {
                x: point.0,
                y: point.1,
            });
            if hwnd.is_invalid() {
                return Err("No window at drop position".into());
            }
            let root = GetAncestor(hwnd, GA_ROOT);
            let mut rect = RECT::default();
            GetWindowRect(root, &mut rect).map_err(|e| e.to_string())?;
            let mut process = 0;
            let thread = GetWindowThreadProcessId(hwnd, Some(&mut process));
            Ok(Self {
                point,
                window: hwnd.0 as usize,
                root: root.0 as usize,
                process,
                thread,
                rect: (rect.left, rect.top, rect.right, rect.bottom),
            })
        }
    }
    pub fn current(&self) -> bool {
        Self::capture(self.point).is_ok_and(|now| {
            now.window == self.window
                && now.root == self.root
                && now.process == self.process
                && now.thread == self.thread
                && now.rect == self.rect
        })
    }
    fn cursor_current(&self) -> bool {
        let mut point = POINT::default();
        unsafe { GetCursorPos(&mut point).is_ok() && (point.x, point.y) == self.point }
    }
}
#[implement(IDropSource)]
struct Source {
    destination: Destination,
    valid: Box<dyn Fn() -> bool + Send>,
    feedback_seen: Cell<bool>,
    accepted: Cell<bool>,
    started: Instant,
}
impl IDropSource_Impl for Source_Impl {
    fn QueryContinueDrag(&self, escape: BOOL, _: MODIFIERKEYS_FLAGS) -> HRESULT {
        if escape.as_bool()
            || self.started.elapsed() > Duration::from_secs(5)
            || !(self.valid)()
            || !self.destination.cursor_current()
        {
            DRAGDROP_S_CANCEL
        } else if self.accepted.get() {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    fn GiveFeedback(&self, effect: DROPEFFECT) -> HRESULT {
        // DragEnter alone does not establish acceptance: embedded/web editors may
        // decide asynchronously after DragOver. Never release on DROPEFFECT_NONE.
        let over = self.feedback_seen.replace(true);
        self.accepted
            .set(over && (effect & DROPEFFECT_COPY) != DROPEFFECT_NONE);
        if self.accepted.get() {
            if let Err(error) = post_drag_message(WM_LBUTTONUP, WPARAM(0)) {
                return error.code();
            }
        }
        DRAGDROP_S_USEDEFAULTCURSORS
    }
}

/// Wake only this STA's OLE capture window; never inject a physical mouse button.
fn post_drag_message(message: u32, keys: WPARAM) -> windows::core::Result<()> {
    unsafe {
        let capture = GetCapture();
        if capture.is_invalid() {
            return Err(E_FAIL.into());
        }
        let mut point = POINT::default();
        GetCursorPos(&mut point)?;
        if !ScreenToClient(capture, &mut point).as_bool()
            || i16::try_from(point.x).is_err()
            || i16::try_from(point.y).is_err()
        {
            return Err(E_FAIL.into());
        }
        let packed = (point.x as u16 as u32) | ((point.y as u16 as u32) << 16);
        PostMessageW(Some(capture), message, keys, LPARAM(packed as isize))
    }
}

struct DragWakeup(usize);
impl DragWakeup {
    fn start() -> Result<Self, String> {
        unsafe extern "system" fn tick(_: HWND, _: u32, _: usize, _: u32) {
            let _ = post_drag_message(WM_MOUSEMOVE, WPARAM(MK_LBUTTON.0 as usize));
        }
        // No busy loop or repeated OS pointer movement while the target processes its data.
        let id = unsafe { SetTimer(None, 0, 16, Some(tick)) };
        if id == 0 {
            Err("Could not start file drop feedback timer".into())
        } else {
            Ok(Self(id))
        }
    }
}
impl Drop for DragWakeup {
    fn drop(&mut self) {
        unsafe {
            let _ = KillTimer(None, self.0);
        }
    }
}
struct Ole;
impl Drop for Ole {
    fn drop(&mut self) {
        unsafe {
            OleUninitialize();
        }
    }
}
pub fn perform(
    destination: &Destination,
    paths: &[String],
    valid: Box<dyn Fn() -> bool + Send>,
) -> Result<(), String> {
    let _dpi = Dpi::enter()?;
    unsafe {
        OleInitialize(None).map_err(|e| e.to_string())?;
        let _ole = Ole;
        let mut pidls = Vec::new();
        for path in paths {
            let wide: Vec<_> = path.encode_utf16().chain(Some(0)).collect();
            let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
            if pidl.is_null() {
                for p in pidls {
                    ILFree(Some(p));
                }
                return Err("Could not create shell file object".into());
            }
            pidls.push(pidl as *const _);
        }
        let object: windows::core::Result<IDataObject> = SHCreateShellItemArrayFromIDLists(&pidls)
            .and_then(|items| items.BindToHandler(None, &BHID_DataObject));
        for p in pidls {
            ILFree(Some(p));
        }
        let object = object.map_err(|e| e.to_string())?;
        if !valid() || !destination.current() {
            return Err("File drop target changed or control ended".into());
        }
        // WM_MOUSE coordinates are signed 16-bit; reject instead of wrapping to another target.
        let x = i16::try_from(destination.point.0)
            .map_err(|_| "Drop position exceeds Windows coordinate range")?;
        let y = i16::try_from(destination.point.1)
            .map_err(|_| "Drop position exceeds Windows coordinate range")?;
        let initial = LPARAM(((x as u16 as u32) | ((y as u16 as u32) << 16)) as isize);
        SetCursorPos(destination.point.0, destination.point.1).map_err(|e| e.to_string())?;
        let source: IDropSource = Source {
            destination: destination.clone(),
            valid,
            feedback_seen: Cell::new(false),
            accepted: Cell::new(false),
            started: Instant::now(),
        }
        .into();
        let mut effect = DROPEFFECT_NONE;
        // A fresh STA has no physical input queued. Seed the OLE loop locally at the real
        // destination so it cannot wait for the host user to move the mouse.
        PostThreadMessageW(
            GetCurrentThreadId(),
            WM_MOUSEMOVE,
            WPARAM(MK_LBUTTON.0 as usize),
            initial,
        )
        .map_err(|e| e.to_string())?;
        let _wakeup = DragWakeup::start()?;
        let result = DoDragDrop(&object, &source, DROPEFFECT_COPY, &mut effect);
        if result == DRAGDROP_S_DROP && (effect & DROPEFFECT_COPY) != DROPEFFECT_NONE {
            Ok(())
        } else if result == DRAGDROP_S_CANCEL {
            Err("File drop cancelled or target changed".into())
        } else {
            Err(format!(
                "Target did not accept the file drop ({result:?}, effect={})",
                effect.0
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};
    use windows::{
        core::{w, Ref},
        Win32::{
            Foundation::{HWND, POINTL},
            System::{
                Com::{DVASPECT_CONTENT, FORMATETC, TYMED_HGLOBAL},
                DataExchange::GetClipboardSequenceNumber,
                Ole::{
                    IDropTarget, IDropTarget_Impl, RegisterDragDrop, ReleaseStgMedium,
                    RevokeDragDrop,
                },
            },
            UI::{
                Shell::{DragQueryFileW, HDROP},
                WindowsAndMessaging::{
                    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
                    RegisterClassW, TranslateMessage, MSG, PM_REMOVE, WNDCLASSW, WS_EX_TOOLWINDOW,
                    WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
                },
            },
        },
    };
    #[implement(IDropTarget)]
    struct Target {
        events: Arc<Mutex<Vec<String>>>,
        accept: bool,
        accept_delay: Duration,
        entered: Cell<Option<Instant>>,
    }
    impl IDropTarget_Impl for Target_Impl {
        fn DragEnter(
            &self,
            _: Ref<IDataObject>,
            _: MODIFIERKEYS_FLAGS,
            _: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            self.events.lock().unwrap().push("enter".into());
            self.entered.set(Some(Instant::now()));
            unsafe {
                *effect = if self.accept && self.accept_delay.is_zero() {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
            Ok(())
        }
        fn DragOver(
            &self,
            _: MODIFIERKEYS_FLAGS,
            _: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            self.events.lock().unwrap().push("over".into());
            unsafe {
                *effect = if self.accept
                    && self
                        .entered
                        .get()
                        .is_some_and(|at| at.elapsed() >= self.accept_delay)
                {
                    DROPEFFECT_COPY
                } else {
                    DROPEFFECT_NONE
                };
            }
            Ok(())
        }
        fn DragLeave(&self) -> windows::core::Result<()> {
            Ok(())
        }
        fn Drop(
            &self,
            object: Ref<IDataObject>,
            _: MODIFIERKEYS_FLAGS,
            _: &POINTL,
            effect: *mut DROPEFFECT,
        ) -> windows::core::Result<()> {
            unsafe {
                let format = FORMATETC {
                    cfFormat: 15,
                    dwAspect: DVASPECT_CONTENT.0,
                    lindex: -1,
                    tymed: TYMED_HGLOBAL.0 as u32,
                    ..Default::default()
                };
                let mut medium = object.unwrap().GetData(&format)?;
                let drop = HDROP(medium.u.hGlobal.0);
                let mut path = vec![0u16; DragQueryFileW(drop, 0, None) as usize + 1];
                DragQueryFileW(drop, 0, Some(&mut path));
                let path = String::from_utf16_lossy(&path[..path.len() - 1]);
                assert_eq!(std::fs::read(&path).unwrap(), [0, 255, 42]);
                ReleaseStgMedium(&mut medium);
                self.events.lock().unwrap().push("drop".into());
                *effect = DROPEFFECT_COPY;
            }
            Ok(())
        }
    }
    unsafe extern "system" fn window_proc(
        hwnd: HWND,
        message: u32,
        w: WPARAM,
        l: LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        unsafe { DefWindowProcW(hwnd, message, w, l) }
    }
    fn drop_in_worker(
        destination: &Destination,
        path: &std::path::Path,
        valid: Box<dyn Fn() -> bool + Send>,
    ) -> Result<(), String> {
        // Production uses a fresh STA; marshal into a different target thread.
        let destination = destination.clone();
        let path = path.to_string_lossy().into_owned();
        let worker = std::thread::spawn(move || perform(&destination, &[path], valid));
        let deadline = Instant::now() + Duration::from_secs(8);
        while !worker.is_finished() {
            unsafe {
                let mut message = MSG::default();
                while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
            assert!(Instant::now() < deadline, "OLE worker did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
        worker.join().unwrap()
    }
    #[test]
    #[ignore = "opens a temporary native OLE target and moves the cursor"]
    fn real_ole_drop_delivers_files_without_clipboard_changes() {
        unsafe {
            let _dpi = Dpi::enter().unwrap();
            OleInitialize(None).unwrap();
            let _ole = Ole;
            RegisterClassW(&WNDCLASSW {
                lpfnWndProc: Some(window_proc),
                lpszClassName: w!("WeblinkOleDropTest"),
                ..Default::default()
            });
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                w!("WeblinkOleDropTest"),
                w!("Weblink drop test"),
                WS_POPUP | WS_VISIBLE,
                100,
                100,
                160,
                120,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            struct Window(HWND, POINT);
            impl std::ops::Drop for Window {
                fn drop(&mut self) {
                    unsafe {
                        let _ = RevokeDragDrop(self.0);
                        let _ = DestroyWindow(self.0);
                        let _ = SetCursorPos(self.1.x, self.1.y);
                    }
                }
            }
            let mut original = POINT::default();
            GetCursorPos(&mut original).unwrap();
            let _window = Window(hwnd, original);
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("test.bin");
            std::fs::write(&path, [0, 255, 42]).unwrap();
            let events = Arc::new(Mutex::new(Vec::new()));
            let target: IDropTarget = Target {
                events: events.clone(),
                accept: true,
                accept_delay: Duration::ZERO,
                entered: Cell::new(None),
            }
            .into();
            RegisterDragDrop(hwnd, &target).unwrap();
            let destination = Destination::capture((180, 160)).unwrap();
            assert_eq!(destination.window, hwnd.0 as usize);
            let clipboard = GetClipboardSequenceNumber();
            drop_in_worker(&destination, &path, Box::new(|| true)).unwrap();
            assert_eq!(events.lock().unwrap().first().unwrap(), "enter");
            assert_eq!(events.lock().unwrap().last().unwrap(), "drop");
            assert_eq!(GetClipboardSequenceNumber(), clipboard);
            RevokeDragDrop(hwnd).unwrap();
            events.lock().unwrap().clear();
            let target: IDropTarget = Target {
                events: events.clone(),
                accept: true,
                accept_delay: Duration::from_millis(120),
                entered: Cell::new(None),
            }
            .into();
            RegisterDragDrop(hwnd, &target).unwrap();
            let outcome = drop_in_worker(&destination, &path, Box::new(|| true));
            assert!(
                outcome.is_ok(),
                "target awaiting asynchronous acceptance: {outcome:?}; events: {:?}",
                events.lock().unwrap()
            );
            assert!(events.lock().unwrap().contains(&"over".to_string()));
            assert_eq!(events.lock().unwrap().last().unwrap(), "drop");
            assert_eq!(GetClipboardSequenceNumber(), clipboard);
            RevokeDragDrop(hwnd).unwrap();
            events.lock().unwrap().clear();
            let target: IDropTarget = Target {
                events: events.clone(),
                accept: false,
                accept_delay: Duration::ZERO,
                entered: Cell::new(None),
            }
            .into();
            RegisterDragDrop(hwnd, &target).unwrap();
            let pending_events = events.clone();
            assert!(drop_in_worker(
                &destination,
                &path,
                Box::new(move || !pending_events.lock().unwrap().iter().any(|e| e == "over")),
            )
            .is_err());
            assert!(events.lock().unwrap().iter().any(|e| e == "over"));
            assert!(!events.lock().unwrap().iter().any(|e| e == "drop"));
            events.lock().unwrap().clear();
            assert!(drop_in_worker(&destination, &path, Box::new(|| true)).is_err());
            assert!(!events.lock().unwrap().iter().any(|e| e == "drop"));
            assert_eq!(GetClipboardSequenceNumber(), clipboard);
        }
    }
}
