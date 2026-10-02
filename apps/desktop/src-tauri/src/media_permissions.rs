/// Refresh the application's WebView grants without changing OS privacy settings.
#[cfg(windows)]
pub fn configure(window: &tauri::WebviewWindow, origins: &[tauri::Url]) -> tauri::Result<()> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile4, ICoreWebView2_13, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
            COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        },
        SetPermissionStateCompletedHandler,
    };
    use windows_core::{Interface, HSTRING, PCWSTR};

    let origins: Vec<String> = origins
        .iter()
        .map(|url| url.origin().ascii_serialization())
        .collect();
    let owner = window.clone();
    window.with_webview(move |view| {
        let configure = || -> windows_core::Result<()> {
            unsafe {
                let webview: ICoreWebView2_13 = view.controller().CoreWebView2()?.cast()?;
                let profile: ICoreWebView2Profile4 = webview.Profile()?.cast()?;
                for origin in &origins {
                    let origin = HSTRING::from(origin);
                    for kind in [COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_KIND_CAMERA] {
                        let owner = owner.clone();
                        let completed = SetPermissionStateCompletedHandler::create(Box::new(move |result| {
                            if let Err(error) = result {
                                eprintln!("could not configure Weblink media permission: {error}");
                            } else {
                                // Discovery may already be mounted when the asynchronous profile update completes.
                                let _ = owner.eval("navigator.mediaDevices?.dispatchEvent(new Event('devicechange'))");
                            }
                            Ok(())
                        }));
                        profile.SetPermissionState(kind, PCWSTR(origin.as_ptr()), COREWEBVIEW2_PERMISSION_STATE_ALLOW, &completed)?;
                    }
                }
            }
            Ok(())
        };
        if let Err(error) = configure() {
            eprintln!("could not initialize Weblink media permissions: {error}");
        }
    })
}

#[cfg(not(windows))]
pub fn configure(_: &tauri::WebviewWindow, _: &[tauri::Url]) -> tauri::Result<()> {
    Ok(())
}
