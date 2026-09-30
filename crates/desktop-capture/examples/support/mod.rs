use std::{
    sync::mpsc,
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use windows::{
    core::{w, HSTRING},
    Win32::UI::WindowsAndMessaging::*,
};
enum WindowCommand {
    Resize(mpsc::Sender<Result<(), String>>),
    Repaint(u64, mpsc::Sender<Result<(), String>>),
    Scene(u64, mpsc::Sender<Result<(), String>>),
    Close,
}
pub struct TestWindow {
    commands: mpsc::Sender<WindowCommand>,
    worker: Option<JoinHandle<()>>,
}
impl TestWindow {
    pub fn new(title: String) -> Result<Self, String> {
        let (commands, receiver) = mpsc::channel();
        let (ready, initialized) = mpsc::channel();
        // Keep pumping this window while the test thread blocks on native capture.
        // WinRT item creation and window enumeration can send synchronous window messages.
        let worker = thread::spawn(move || {
            let burst = std::env::args().any(|arg| arg == "--scene-burst");
            let window = unsafe {
                CreateWindowExW(
                    WINDOW_EX_STYLE::default(),
                    w!("STATIC"),
                    &HSTRING::from(title),
                    WS_OVERLAPPEDWINDOW | WS_VISIBLE,
                    100,
                    100,
                    if burst { 1300 } else { 400 },
                    if burst { 760 } else { 260 },
                    None,
                    None,
                    None,
                    None,
                )
            };
            let hwnd = match window {
                Ok(hwnd) => hwnd,
                Err(error) => {
                    let _ = ready.send(Err(error.to_string()));
                    return;
                }
            };
            let scene_width = 1536_usize;
            let scene_height = 800_usize;
            let scene: Vec<u32> = if burst {
                (0..scene_width * scene_height)
                    .map(|i| {
                        let x = (i % scene_width) / 8;
                        let y = (i / scene_width) / 8;
                        let hash = (x as u32).wrapping_mul(2654435761)
                            ^ (y as u32).wrapping_mul(2246822519);
                        let luma = 24 + ((hash >> 8) % 208);
                        luma * 0x010101
                    })
                    .collect()
            } else {
                vec![]
            };
            let _ = ready.send(Ok(()));
            let mut repaint_until: Option<Instant> = None;
            let mut paint = 0;
            while unsafe { IsWindow(Some(hwnd)).as_bool() } {
                match receiver.try_recv() {
                    Ok(WindowCommand::Resize(reply)) => {
                        let result = unsafe {
                            SetWindowPos(hwnd, None, 0, 0, 560, 360, SWP_NOMOVE | SWP_NOZORDER)
                        };
                        // STATIC does not animate. Keep this test source repainting
                        // briefly while WGC recreates its resized frame pool.
                        repaint_until = Some(Instant::now() + Duration::from_millis(250));
                        let mut rect = windows::Win32::Foundation::RECT::default();
                        unsafe {
                            let _ = GetWindowRect(hwnd, &mut rect);
                        }
                        println!(
                            "test window after resize: {:?}; visible={}, minimized={}",
                            rect,
                            unsafe { IsWindowVisible(hwnd).as_bool() },
                            unsafe { IsIconic(hwnd).as_bool() }
                        );
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    Ok(WindowCommand::Repaint(frame, reply)) => {
                        let result = unsafe {
                            SetWindowTextW(
                                hwnd,
                                &HSTRING::from(format!("Weblink native test frame {frame}")),
                            )
                        };
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    Ok(WindowCommand::Scene(frame, reply)) => {
                        use windows::Win32::{Foundation::RECT, Graphics::Gdi::*};
                        let result = unsafe {
                            (|| -> Result<(), String> {
                                if scene.is_empty() {
                                    return Err("Scene fixture requires --scene-burst".into());
                                }
                                let mut rect = RECT::default();
                                GetClientRect(hwnd, &mut rect).map_err(|e| e.to_string())?;
                                let dc = GetDC(Some(hwnd));
                                let mut info = BITMAPINFO::default();
                                info.bmiHeader.biSize =
                                    std::mem::size_of::<BITMAPINFOHEADER>() as u32;
                                info.bmiHeader.biWidth = scene_width as i32;
                                info.bmiHeader.biHeight = -(scene_height as i32);
                                info.bmiHeader.biPlanes = 1;
                                info.bmiHeader.biBitCount = 32;
                                info.bmiHeader.biCompression = BI_RGB.0;
                                let drawn = StretchDIBits(
                                    dc,
                                    0,
                                    0,
                                    rect.right,
                                    rect.bottom,
                                    ((frame % 16) * 8) as i32,
                                    0,
                                    rect.right.min(scene_width as i32 - 128),
                                    rect.bottom.min(scene_height as i32),
                                    Some(scene.as_ptr().cast()),
                                    &info,
                                    DIB_RGB_COLORS,
                                    SRCCOPY,
                                );
                                ReleaseDC(Some(hwnd), dc);
                                if drawn == 0 {
                                    return Err("Scene paint failed".into());
                                }
                                Ok(())
                            })()
                        };
                        let _ = reply.send(result);
                    }
                    Ok(WindowCommand::Close) | Err(mpsc::TryRecvError::Disconnected) => break,
                    Err(mpsc::TryRecvError::Empty) => {}
                }
                if repaint_until.is_some_and(|until| Instant::now() < until) {
                    paint += 1;
                    unsafe {
                        let _ = SetWindowTextW(
                            hwnd,
                            &HSTRING::from(format!("Weblink resize test frame {paint}")),
                        );
                    }
                }
                let mut message = MSG::default();
                unsafe {
                    while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                        let _ = TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                thread::sleep(Duration::from_millis(10));
            }
            unsafe {
                let _ = DestroyWindow(hwnd);
            }
        });
        let result = Self {
            commands,
            worker: Some(worker),
        };
        initialized.recv().map_err(|e| e.to_string())??;
        Ok(result)
    }
    pub fn resize(&self) -> Result<(), String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(WindowCommand::Resize(reply))
            .map_err(|e| e.to_string())?;
        receiver.recv().map_err(|e| e.to_string())?
    }
    pub fn repaint(&self, frame: u64) -> Result<(), String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(WindowCommand::Repaint(frame, reply))
            .map_err(|e| e.to_string())?;
        receiver.recv().map_err(|e| e.to_string())?
    }
    #[allow(dead_code)]
    pub fn scene(&self, frame: u64) -> Result<(), String> {
        let (reply, receiver) = mpsc::channel();
        self.commands
            .send(WindowCommand::Scene(frame, reply))
            .map_err(|e| e.to_string())?;
        receiver.recv().map_err(|e| e.to_string())?
    }
    pub fn close(&mut self) {
        let _ = self.commands.send(WindowCommand::Close);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for TestWindow {
    fn drop(&mut self) {
        self.close();
    }
}
