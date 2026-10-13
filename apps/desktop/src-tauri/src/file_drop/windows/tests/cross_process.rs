//! Exercise COM marshaling to another application's UI thread, with the source in the background.
use super::*;
use std::{io::Write, path::Path, process::Command};

fn events(directory: &Path) -> String {
    std::fs::read_to_string(directory.join("events")).unwrap_or_default()
}

pub(super) fn verify() {
    let directory = tempfile::tempdir().unwrap();
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "file_drop::windows::tests::cross_process::target_process",
            "--exact",
            "--ignored",
            "--nocapture",
        ])
        .env("WEBLINK_DROP_TEST_DIRECTORY", directory.path())
        .spawn()
        .unwrap();
    struct Child(std::process::Child);
    impl std::ops::Drop for Child {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let mut child = Child(child);
    let deadline = Instant::now() + Duration::from_secs(10);
    while !directory.path().join("ready").exists() {
        assert!(
            child.0.try_wait().unwrap().is_none(),
            "target process exited"
        );
        assert!(Instant::now() < deadline, "target process did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    let destination = Destination::capture((180, 160)).unwrap();
    assert_eq!(destination.process, child.0.id());
    let placeholder = directory.path().join("drag-preview-1.png");
    std::fs::write(&placeholder, []).unwrap();
    let observe = directory.path().to_path_buf();
    let (ready, feedback) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        preview(
            &[placeholder.to_string_lossy().into_owned()],
            Box::new(move || {
                let events = events(&observe);
                Ok(if events.split(',').filter(|e| *e == "over").count() >= 2 {
                    None
                } else {
                    Some((180, 160))
                })
            }),
            Box::new(move || ready.send(()).unwrap()),
        )
    });
    let result = pump_worker(worker);
    assert!(
        result.is_ok(),
        "cross-process hover: {result:?}; {}",
        events(directory.path())
    );
    feedback
        .try_recv()
        .expect("hover never acknowledged OLE feedback");
    let observed = events(directory.path());
    assert!(observed.starts_with("enter,"), "{observed}");
    assert!(!observed.contains("drop"), "preview must never be dropped");
    let file = directory.path().join("actual.bin");
    std::fs::write(&file, [0, 255, 42]).unwrap();
    let result = drop_in_worker(&destination, &file, Box::new(|| true));
    assert!(
        result.is_ok(),
        "cross-process drop: {result:?}; {}",
        events(directory.path())
    );
    std::fs::write(directory.path().join("stop"), []).unwrap();
    assert!(child.0.wait().unwrap().success());
    assert!(events(directory.path()).contains("drop"));
}

#[test]
#[ignore = "child process for the native file drop lifecycle test"]
fn target_process() {
    let directory = std::path::PathBuf::from(
        std::env::var_os("WEBLINK_DROP_TEST_DIRECTORY").expect("test helper only"),
    );
    unsafe {
        let _dpi = Dpi::enter().unwrap();
        OleInitialize(None).unwrap();
        let _ole = Ole;
        RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: w!("WeblinkSeparateDropTarget"),
            ..Default::default()
        });
        let hwnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
            w!("WeblinkSeparateDropTarget"),
            w!("Separate drop target"),
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
        let observed = Arc::new(Mutex::new(Vec::new()));
        let target: IDropTarget = Target {
            events: observed.clone(),
            accept: true,
            accept_delay: Duration::from_millis(120),
            entered: Cell::new(None),
        }
        .into();
        RegisterDragDrop(hwnd, &target).unwrap();
        let _ = windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow(hwnd);
        let mut log = std::fs::File::create(directory.join("events")).unwrap();
        let mut written = 0;
        std::fs::write(directory.join("ready"), []).unwrap();
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let mut message = MSG::default();
            while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
            let snapshot = observed.lock().unwrap();
            for event in &snapshot[written..] {
                write!(log, "{event},").unwrap();
            }
            written = snapshot.len();
            drop(snapshot);
            if directory.join("stop").exists() {
                break;
            }
            assert!(Instant::now() < deadline, "source process did not finish");
            std::thread::sleep(Duration::from_millis(1));
        }
        RevokeDragDrop(hwnd).unwrap();
        DestroyWindow(hwnd).unwrap();
    }
}
