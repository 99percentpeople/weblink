use super::*;
use crate::presentation::Texture;
use std::time::Duration;
use windows::{
    core::w,
    Win32::{
        Foundation::{LPARAM, WPARAM},
        Graphics::{
            Direct3D11::{ID3D11Device, D3D11_BIND_DECODER, D3D11_TEXTURE2D_DESC},
            Dxgi::Common::DXGI_FORMAT_NV12,
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
        System::Threading::GetCurrentThreadId,
        UI::WindowsAndMessaging::*,
    },
};
unsafe extern "C" {
    fn wl_composition_test_wait() -> i32;
    fn wl_composition_test_cache(hwnd: *mut c_void) -> i32;
}

struct Window {
    hwnd: usize,
    thread_id: u32,
    thread: Option<JoinHandle<()>>,
}
impl Window {
    fn new() -> Self {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).unwrap();
        }
        let (ready, receive) = mpsc::channel();
        let thread = thread::spawn(move || unsafe {
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE,
                w!("STATIC"),
                w!("Weblink presentation test"),
                WS_POPUP,
                0,
                0,
                128,
                96,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            ready.send((hwnd.0 as usize, GetCurrentThreadId())).unwrap();
            let mut message = MSG::default();
            while GetMessageW(&mut message, None, 0, 0).0 > 0 {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            DestroyWindow(hwnd).unwrap();
        });
        let (hwnd, thread_id) = receive.recv_timeout(Duration::from_secs(5)).unwrap();
        Self {
            hwnd,
            thread_id,
            thread: Some(thread),
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        unsafe {
            PostThreadMessageW(self.thread_id, WM_QUIT, WPARAM(0), LPARAM(0)).unwrap();
            self.thread.take().unwrap().join().unwrap();
            CoUninitialize();
        }
    }
}

#[test]
fn native_wait_keeps_wakeups_and_consumes_swap_credit_once() {
    assert_eq!(
        unsafe { wl_composition_test_wait() },
        0,
        "native test failed at line"
    );
}

#[test]
fn processor_cache_reuses_bounds_and_invalidates_on_resize_and_device_change() {
    let window = Window::new();
    assert_eq!(
        unsafe { wl_composition_test_cache(window.hwnd as *mut c_void) },
        0,
        "native test failed at line"
    );
}

fn texture(device: &ID3D11Device, width: u32, height: u32) -> Texture {
    let mut desc = D3D11_TEXTURE2D_DESC {
        Width: width,
        Height: height,
        MipLevels: 1,
        ArraySize: 2,
        Format: DXGI_FORMAT_NV12,
        BindFlags: D3D11_BIND_DECODER.0 as u32,
        ..Default::default()
    };
    desc.SampleDesc.Count = 1;
    let mut texture = None;
    unsafe { device.CreateTexture2D(&desc, None, Some(&mut texture)) }.unwrap();
    Texture {
        cpu_upload: false,
        texture: texture.unwrap(),
        subresource: 0,
        crop: (2, 2),
        size: (width - 4, height - 4),
        bt709: true,
        full_range: false,
        owner: Arc::new(()),
    }
}
fn presented(source: &Source, frames: u64) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while source.stats().presented_frames < frames {
        let stats = source.stats();
        assert!(
            stats.error.is_none(),
            "{stats_error:?}",
            stats_error = stats.error
        );
        assert!(
            Instant::now() < deadline,
            "Timed out waiting for frame {frames}"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn compositor_sleeps_recovers_visibility_and_releases_frame_leases() {
    let window = Window::new();
    let compositor = Compositor::new(window.hwnd).unwrap();
    let source = Arc::new(Source::default());
    let (device, _) = windows_capture::d3d11::create_d3d_device().unwrap();
    let layout = Layout {
        width: 64.,
        height: 36.,
        visible: true,
        ..Default::default()
    };
    compositor.bind(1, source.clone(), layout).unwrap();
    // Preview and receive can use distinct D3D devices in one composition tree.
    let second = Arc::new(Source::default());
    let (other, _) = windows_capture::d3d11::create_d3d_device().unwrap();
    let second_frame = texture(&other, 1284, 724);
    compositor.bind(2, second.clone(), layout).unwrap();
    let small = texture(&device, 644, 364);
    for i in 0..12 {
        let mut frame = small.clone();
        frame.subresource = i % 2;
        frame.bt709 = i % 2 == 0;
        frame.full_range = i % 3 == 0;
        source.publish(frame);
        second.publish(second_frame.clone());
        presented(&source, i as u64 + 1);
        presented(&second, i as u64 + 1);
    }
    thread::sleep(Duration::from_millis(100));
    let cycles = compositor.state.lock().unwrap().cycles;
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        compositor.state.lock().unwrap().cycles,
        cycles,
        "Idle renderer kept waking"
    );

    compositor
        .bind(
            1,
            source.clone(),
            Layout {
                visible: false,
                ..layout
            },
        )
        .unwrap();
    thread::sleep(Duration::from_millis(50));
    let before = source.stats().presented_frames;
    let large = texture(&device, 1284, 724);
    source.publish(large.clone());
    second.publish(second_frame.clone());
    presented(&second, 13);
    thread::sleep(Duration::from_millis(100));
    assert_eq!(
        source.stats().presented_frames,
        before,
        "Hidden surface presented"
    );
    let cycles = compositor.state.lock().unwrap().cycles;
    for _ in 0..20 {
        source.publish(large.clone());
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(
        compositor.state.lock().unwrap().cycles,
        cycles,
        "Hidden source kept waking the compositor"
    );
    compositor.bind(1, source.clone(), layout).unwrap();
    presented(&source, before + 1);

    let owner = Arc::new(());
    let weak = Arc::downgrade(&owner);
    let mut final_frame = large;
    final_frame.owner = owner;
    source.publish(final_frame);
    presented(&source, before + 2);
    source.close();
    second.close();
    compositor.remove(1);
    compositor.remove(2);
    drop(compositor); // Joins the worker only after its GPU lease is safe to drop.
    assert!(
        weak.upgrade().is_none(),
        "Closed compositor retained a decoder lease"
    );
    assert!(source.stats().error.is_none());
}

#[test]
fn pooled_software_uploads_present_and_record_without_overwriting_held_frames() {
    use libwebrtc::video_frame::{NV12Buffer, VideoBuffer, VideoFrame, VideoRotation};
    let window = Window::new();
    let compositor = Compositor::new(window.hwnd).unwrap();
    let source = Arc::new(Source::default());
    let mut upload = crate::presentation::upload::Upload::default();
    compositor
        .bind(
            1,
            source.clone(),
            Layout {
                width: 64.,
                height: 36.,
                visible: true,
                ..Default::default()
            },
        )
        .unwrap();
    let recording = source.recording();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    for sequence in 1..=24u64 {
        let mut buffer = NV12Buffer::new(640, 360);
        buffer.data_mut().0.fill(sequence as u8);
        buffer.data_mut().1.fill(128);
        let frame = VideoFrame::new(
            VideoRotation::VideoRotation0,
            Box::new(buffer) as Box<dyn VideoBuffer>,
        );
        source.publish(upload.frame(&frame).unwrap().unwrap());
        presented(&source, sequence);
        let data = runtime
            .block_on(recording.read_frame(sequence - 1))
            .unwrap();
        assert!(data[24..24 + 640 * 360]
            .iter()
            .all(|&v| v == sequence as u8));
        assert!(data[24 + 640 * 360..].iter().all(|&v| v == 128));
    }
    recording.close();
    source.close();
    drop(upload);
    drop(compositor);
    assert!(source.stats().error.is_none());
}
