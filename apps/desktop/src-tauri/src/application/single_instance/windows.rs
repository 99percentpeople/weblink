use crate::application::{executable::normalized_path, show};
use sha2::{Digest, Sha256};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::{
    plugin::{Builder, TauriPlugin},
    AppHandle, Manager, RunEvent, Wry,
};
use windows::{
    core::{HSTRING, PCWSTR},
    Win32::{
        Foundation::{
            CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM, LRESULT, WPARAM,
        },
        System::{LibraryLoader::GetModuleHandleW, Threading::CreateMutexW},
        UI::WindowsAndMessaging::*,
    },
};

const ACTIVATE: u32 = WM_APP + 1;

// Use a stable digest rather than Rust's version-dependent DefaultHasher so a
// rebuilt binary at the same path still finds a previously running instance.
fn instance_id(identifier: &str, exe: &Path) -> String {
    let path = normalized_path(exe).to_lowercase();
    format!("{identifier}.exe.{:x}", Sha256::digest(path.as_bytes()))
}

struct InstanceMutex(isize);

impl Drop for InstanceMutex {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(HANDLE(self.0 as _)) };
    }
}

fn open_mutex(id: &str) -> windows::core::Result<(InstanceMutex, bool)> {
    let name = HSTRING::from(format!("{id}.mutex"));
    // Existence, not thread ownership, is the lifetime guard. Every handle is
    // closed, including secondary launches and failed initialization attempts.
    let handle = unsafe { CreateMutexW(None, false, &name)? };
    let exists = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    Ok((InstanceMutex(handle.0 as isize), exists))
}

struct Activation {
    request: Box<dyn Fn() + Send + Sync>,
}

fn activate(app: &AppHandle, pending: &AtomicBool) {
    if app.get_webview_window("main").is_some() && pending.swap(false, Ordering::AcqRel) {
        show(app);
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    let data = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut Activation;
    match message {
        ACTIVATE if !data.is_null() => {
            let activation = &*data;
            (activation.request)();
            LRESULT(0)
        }
        WM_NCDESTROY if !data.is_null() => {
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            drop(Box::from_raw(data));
            DefWindowProcW(hwnd, message, wparam, lparam)
        }
        _ => DefWindowProcW(hwnd, message, wparam, lparam),
    }
}

struct Resources {
    window: isize,
    class: HSTRING,
    _mutex: InstanceMutex,
}

impl Drop for Resources {
    fn drop(&mut self) {
        // Created and released by plugin hooks on the application's UI thread.
        unsafe {
            let _ = DestroyWindow(HWND(self.window as _));
            let module = GetModuleHandleW(None).ok().map(Into::into);
            let _ = UnregisterClassW(&self.class, module);
        }
    }
}

struct Service {
    resources: Mutex<Option<Resources>>,
    pending: Arc<AtomicBool>,
}

fn create_receiver(
    id: &str,
    mutex: InstanceMutex,
    request: impl Fn() + Send + Sync + 'static,
) -> windows::core::Result<Resources> {
    let class = HSTRING::from(id);
    let module = unsafe { GetModuleHandleW(None)? };
    let definition = WNDCLASSW {
        lpfnWndProc: Some(window_proc),
        hInstance: module.into(),
        lpszClassName: PCWSTR(class.as_ptr()),
        ..Default::default()
    };
    if unsafe { RegisterClassW(&definition) } == 0 {
        return Err(windows::core::Error::from_thread());
    }
    let window = unsafe {
        CreateWindowExW(
            WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            &class,
            &class,
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            Some(module.into()),
            None,
        )
    };
    let window = match window {
        Ok(window) => window,
        Err(error) => {
            let _ = unsafe { UnregisterClassW(&class, Some(module.into())) };
            return Err(error);
        }
    };
    let data = Box::into_raw(Box::new(Activation {
        request: Box::new(request),
    }));
    unsafe {
        SetWindowLongPtrW(window, GWLP_USERDATA, data as isize);
    }
    Ok(Resources {
        window: window.0 as isize,
        class,
        _mutex: mutex,
    })
}

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("single-instance")
        .setup(|app, _| {
            let exe = std::env::current_exe()?;
            let id = instance_id(&app.config().identifier, &exe);
            let name = HSTRING::from(id.as_str());
            // A concurrent first launch may hold the mutex before its receiver
            // exists. Retry with fresh handles so a crashed owner can be replaced.
            for _ in 0..100 {
                let (mutex, exists) = open_mutex(&id)?;
                if !exists {
                    let pending = Arc::new(AtomicBool::new(false));
                    let receiver_app = app.clone();
                    let receiver_pending = pending.clone();
                    let resources = create_receiver(&id, mutex, move || {
                        receiver_pending.store(true, Ordering::Release);
                        activate(&receiver_app, &receiver_pending);
                    })?;
                    app.manage(Service {
                        resources: Mutex::new(Some(resources)),
                        pending,
                    });
                    return Ok(());
                }
                if let Ok(window) = unsafe { FindWindowW(&name, &name) } {
                    if !std::env::args().any(|arg| arg == "--autostart") {
                        let mut process_id = 0;
                        unsafe {
                            GetWindowThreadProcessId(window, Some(&mut process_id));
                            let _ = AllowSetForegroundWindow(process_id);
                            PostMessageW(Some(window), ACTIVATE, WPARAM(0), LPARAM(0))?;
                        }
                    }
                    drop(mutex);
                    app.cleanup_before_exit();
                    std::process::exit(0);
                }
                drop(mutex);
                thread::sleep(Duration::from_millis(20));
            }
            Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "The running Weblink instance is not ready",
            )
            .into())
        })
        .on_event(|app, event| {
            let Some(service) = app.try_state::<Service>() else {
                return;
            };
            match event {
                RunEvent::Ready => activate(app, &service.pending),
                RunEvent::Exit => {
                    service
                        .resources
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .take();
                }
                _ => {}
            }
        })
        .build()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn executable_path_scopes_instances_independently_of_build_mode() {
        let release = instance_id(
            "ink.webl.desktop",
            Path::new(r"C:\Weblink\target\release\weblink-desktop.exe"),
        );
        let debug = instance_id(
            "ink.webl.desktop",
            Path::new(r"C:\Weblink\target\debug\weblink-desktop.exe"),
        );
        let other = instance_id(
            "ink.webl.desktop",
            Path::new(r"C:\Other\target\release\weblink-desktop.exe"),
        );
        assert_ne!(release, debug);
        assert_ne!(release, other);
        assert_eq!(
            release,
            instance_id(
                "ink.webl.desktop",
                Path::new(r"\\?\c:/WEBLINK/target/release/weblink-desktop.exe")
            )
        );
    }

    #[test]
    fn same_path_is_exclusive_different_paths_coexist_and_exit_releases_the_lock() {
        let directory = tempfile::tempdir().unwrap();
        let first_id = instance_id("weblink-test", &directory.path().join("first.exe"));
        let second_id = instance_id("weblink-test", &directory.path().join("second.exe"));
        let (first, exists) = open_mutex(&first_id).unwrap();
        assert!(!exists);
        let (duplicate, exists) = open_mutex(&first_id).unwrap();
        assert!(exists);
        let (second, exists) = open_mutex(&second_id).unwrap();
        assert!(!exists);
        drop(duplicate);
        drop(first);
        let (_restarted, exists) = open_mutex(&first_id).unwrap();
        assert!(!exists);
        drop(second);
    }

    #[test]
    fn activation_reaches_only_the_matching_path_and_releases_native_resources() {
        let directory = tempfile::tempdir().unwrap();
        let mut receivers = Vec::new();
        let mut activated = Vec::new();
        for file in ["release.exe", "debug.exe"] {
            let id = instance_id("weblink-test", &directory.path().join(file));
            let (mutex, exists) = open_mutex(&id).unwrap();
            assert!(!exists);
            let flag = Arc::new(AtomicBool::new(false));
            let receiver_flag = flag.clone();
            receivers.push(
                create_receiver(&id, mutex, move || {
                    receiver_flag.store(true, Ordering::Release);
                })
                .unwrap(),
            );
            activated.push(flag);
        }
        let id = instance_id("weblink-test", &directory.path().join("debug.exe"));
        let name = HSTRING::from(id.as_str());
        unsafe {
            let window = FindWindowW(&name, &name).unwrap();
            PostMessageW(Some(window), ACTIVATE, WPARAM(0), LPARAM(0)).unwrap();
            let mut message = MSG::default();
            assert!(
                PeekMessageW(&mut message, Some(window), ACTIVATE, ACTIVATE, PM_REMOVE).as_bool()
            );
            DispatchMessageW(&message);
        }
        assert!(!activated[0].load(Ordering::Acquire));
        assert!(activated[1].load(Ordering::Acquire));
        drop(receivers);
        assert!(unsafe { FindWindowW(&name, &name) }.is_err());
        let (mutex, exists) = open_mutex(&id).unwrap();
        assert!(!exists);
        // Also verifies that the old window class was unregistered.
        let _restarted = create_receiver(&id, mutex, || {}).unwrap();
    }
}
