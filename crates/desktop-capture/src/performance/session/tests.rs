use super::*;

#[test]
fn independent_captures_share_timing_and_closed_sessions_reject_late_leases() {
    let manager = Arc::new(Manager::default());
    let first = manager.session();
    let second = manager.session();
    assert!(first.enter_thread(ThreadRole::Capture).is_none());
    assert_eq!(first.snapshot().timing, Status::Inactive);
    let a = first.acquire().unwrap();
    let b = first.acquire().unwrap();
    let c = second.acquire().unwrap();
    assert_eq!(first.snapshot().remote_consumers, 2);
    drop(a);
    first.close();
    first.close();
    drop(b);
    assert!(first.acquire().is_none());
    assert!(first.enter_thread(ThreadRole::Encode).is_none());
    assert_eq!(second.snapshot().remote_consumers, 1);
    assert!(manager.timers.inspect(&(), |entry| entry.is_some()));
    drop(c);
    assert_eq!(second.snapshot().timing, Status::Inactive);
    assert!(manager.timers.inspect(&(), |entry| entry.is_none()));
}

#[cfg(windows)]
#[test]
fn native_thread_priority_is_restored_after_nested_work_and_unwind() {
    std::thread::spawn(|| {
        use windows::Win32::System::Threading::{GetCurrentThread, GetThreadPriority};
        let initial = unsafe { GetThreadPriority(GetCurrentThread()) };
        let session = Arc::new(Manager::default()).session();
        let _lease = session.acquire().unwrap();
        let returned = session.with_thread(ThreadRole::Capture, || {
            let captured = unsafe { GetThreadPriority(GetCurrentThread()) };
            assert_eq!(captured, initial.max(1));
            session.with_thread(ThreadRole::Encode, || {
                assert_eq!(
                    unsafe { GetThreadPriority(GetCurrentThread()) },
                    initial.max(2)
                );
            });
            assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, captured);
            42
        });
        assert_eq!(returned, 42);
        assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, initial);
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            session.with_thread(ThreadRole::Encode, || panic!("simulate encoder failure"));
        }));
        assert!(result.is_err());
        assert_eq!(unsafe { GetThreadPriority(GetCurrentThread()) }, initial);
    })
    .join()
    .unwrap();
}

#[cfg(windows)]
#[test]
#[ignore = "Requires a D3D11 hardware device; changes only temporary test device priorities"]
fn native_gpu_priority_is_shared_and_restored_on_replacement_and_final_release() {
    use windows::{
        core::Interface,
        Win32::Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::*,
            Dxgi::IDXGIDevice,
        },
    };
    fn device() -> ID3D11Device {
        let mut device = None;
        unsafe {
            D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                windows::Win32::Foundation::HMODULE::default(),
                D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                None,
            )
        }
        .unwrap();
        device.unwrap()
    }
    fn priority(device: &ID3D11Device) -> i32 {
        unsafe { device.cast::<IDXGIDevice>().unwrap().GetGPUThreadPriority() }.unwrap()
    }
    let a = device();
    let b = device();
    let initial = (priority(&a), priority(&b));
    let manager = Arc::new(Manager::default());
    let first = manager.session();
    let second = manager.session();
    first.set_gpu_device(&a);
    second.set_gpu_device(&a);
    assert_eq!(
        priority(&a),
        initial.0,
        "preview-only capture must not raise GPU priority"
    );
    let first_lease = first.acquire().unwrap();
    let second_lease = second.acquire().unwrap();
    assert_eq!(priority(&a), 7);
    first.set_gpu_device(&b);
    assert_eq!((priority(&a), priority(&b)), (7, 7));
    drop(second_lease);
    assert_eq!(priority(&a), initial.0);
    assert_eq!(priority(&b), 7);
    first.close();
    drop(first_lease);
    assert_eq!((priority(&a), priority(&b)), initial);
    assert!(manager
        .devices
        .inspect(&platform::device_key(&a).unwrap(), |entry| entry.is_none()));
    assert!(manager
        .devices
        .inspect(&platform::device_key(&b).unwrap(), |entry| entry.is_none()));
}
