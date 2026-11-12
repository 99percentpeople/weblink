//! Interface changes update advertised URLs without polling on Windows.
use super::*;

pub(super) fn start(service: Shared, cancel: CancellationToken) {
    tauri::async_runtime::spawn(async move {
        #[cfg(windows)]
        if let Some(watch) = windows::Watch::start(service.changes.clone()) {
            cancel.cancelled().await;
            // Cancellation waits for callbacks; never run it in a callback or
            // while holding the service mutex.
            let _ = tauri::async_runtime::spawn_blocking(move || drop(watch)).await;
            return;
        }
        // Platforms without an interface observer (or failed registration) only
        // sample advertised URLs. No permissions/jobs/status query is involved.
        let mut changes = service.changes.subscribe();
        let mut previous = Vec::new();
        loop {
            let active = service.state.lock().unwrap().active_server.clone();
            let wildcard = active.as_ref().is_some_and(|config| {
                config
                    .host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_unspecified())
            });
            let endpoints = server::endpoints(active.as_ref());
            if previous != endpoints {
                previous = endpoints;
                service.changes.notify();
            }
            tokio::select! {
                biased;
                _ = cancel.cancelled() => break,
                result = changes.changed() => if result.is_err() { break; },
                _ = async {
                    if wildcard {
                        tokio::time::sleep(Duration::from_secs(30)).await;
                    } else {
                        std::future::pending::<()>().await;
                    }
                } => {},
            }
        }
    });
}

#[cfg(windows)]
mod windows {
    use super::status::Changes;
    use ::windows::Win32::{
        Foundation::HANDLE,
        NetworkManagement::IpHelper::{
            CancelMibChangeNotify2, NotifyIpInterfaceChange, NotifyUnicastIpAddressChange,
            MIB_IPINTERFACE_ROW, MIB_NOTIFICATION_TYPE, MIB_UNICASTIPADDRESS_ROW,
        },
        Networking::WinSock::AF_UNSPEC,
    };
    use std::{ffi::c_void, sync::Arc};

    pub(super) struct Watch {
        handles: Vec<isize>,
        context: Option<Arc<Changes>>,
    }
    impl Watch {
        pub fn start(changes: Arc<Changes>) -> Option<Self> {
            let context = Arc::as_ptr(&changes).cast::<c_void>();
            let mut watch = Self {
                handles: Vec::new(),
                context: Some(changes),
            };
            unsafe {
                let mut handle = HANDLE::default();
                if NotifyUnicastIpAddressChange(
                    AF_UNSPEC,
                    Some(address_changed),
                    Some(context),
                    false,
                    &mut handle,
                )
                .0 != 0
                {
                    return None;
                }
                watch.handles.push(handle.0 as isize);
                if NotifyIpInterfaceChange(
                    AF_UNSPEC,
                    Some(interface_changed),
                    Some(context),
                    false,
                    &mut handle,
                )
                .0 != 0
                {
                    return None;
                }
                watch.handles.push(handle.0 as isize);
            }
            Some(watch)
        }
    }
    impl Drop for Watch {
        fn drop(&mut self) {
            let mut cancelled = true;
            for handle in self.handles.drain(..) {
                cancelled &=
                    unsafe { CancelMibChangeNotify2(HANDLE(handle as *mut c_void)).0 == 0 };
            }
            if !cancelled {
                // Keep callback memory valid if the OS couldn't unregister it.
                std::mem::forget(self.context.take());
            }
        }
    }
    unsafe extern "system" fn address_changed(
        context: *const c_void,
        _: *const MIB_UNICASTIPADDRESS_ROW,
        _: MIB_NOTIFICATION_TYPE,
    ) {
        unsafe { (&*context.cast::<Changes>()).notify() };
    }
    unsafe extern "system" fn interface_changed(
        context: *const c_void,
        _: *const MIB_IPINTERFACE_ROW,
        _: MIB_NOTIFICATION_TYPE,
    ) {
        unsafe { (&*context.cast::<Changes>()).notify() };
    }
}
