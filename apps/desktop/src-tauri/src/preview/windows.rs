//! WebView2 shared memory. COM access and buffer writes stay on the UI thread.
use std::{cell::RefCell, collections::HashMap, sync::Weak};
use tauri::Webview;
use weblink_desktop_capture::media::{
    preview::{PreviewFrame, BUFFER_SIZE},
    MediaSession,
};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
};
use windows_core::{Interface, HSTRING};
struct Buffer {
    shared: ICoreWebView2SharedBuffer,
    media: Weak<MediaSession>,
    owner: String,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        let _ = unsafe { self.shared.Close() };
    }
}
thread_local! { static BUFFERS: RefCell<HashMap<String, Buffer>> = RefCell::new(HashMap::new()); }

async fn on_view<T: Send + 'static>(
    webview: Webview,
    operation: impl FnOnce(tauri::webview::PlatformWebview) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (send, mut receive) = tauri::async_runtime::channel(1);
    webview
        .with_webview(move |view| {
            let _ = send.try_send(operation(view));
        })
        .map_err(|e| e.to_string())?;
    receive.recv().await.ok_or("Preview webview closed")?
}

pub fn clear(webview: &tauri::WebviewWindow) {
    let owner = webview.label().to_owned();
    let _ = webview.with_webview(move |_| {
        BUFFERS.with(|buffers| {
            buffers
                .borrow_mut()
                .retain(|_, buffer| buffer.owner != owner)
        })
    });
}

pub async fn open(
    webview: Webview,
    media: std::sync::Arc<MediaSession>,
    preview_id: String,
) -> Result<(), String> {
    let owner = webview.label().to_owned();
    on_view(webview, move |view| {
        BUFFERS.with(|buffers| -> Result<(), String> {
            let mut buffers = buffers.borrow_mut();
            buffers.retain(|_, buffer| buffer.media.strong_count() > 0);
            if buffers.contains_key(&preview_id) || buffers.len() >= 16 {
                return Err("Preview already exists or limit reached".into());
            }
            let shared = (|| -> windows_core::Result<_> {
                unsafe {
                    let environment: ICoreWebView2Environment12 = view.environment().cast()?;
                    let shared = environment.CreateSharedBuffer(BUFFER_SIZE as u64)?;
                    let webview: ICoreWebView2_17 = view.controller().CoreWebView2()?.cast()?;
                    let metadata = HSTRING::from(
                        serde_json::json!({"kind":"weblink-preview", "id":preview_id}).to_string(),
                    );
                    webview.PostSharedBufferToScript(
                        &shared,
                        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                        &metadata,
                    )?;
                    Ok(shared)
                }
            })()
            .map_err(|e| format!("WebView2 shared-memory preview is unavailable: {e}"))?;
            buffers.insert(
                preview_id,
                Buffer {
                    shared,
                    media: std::sync::Arc::downgrade(&media),
                    owner,
                },
            );
            Ok(())
        })
    })
    .await
}

pub async fn frame(
    webview: Webview,
    preview_id: String,
    after: u64,
) -> Result<Option<PreviewFrame>, String> {
    let owner = webview.label().to_owned();
    on_view(webview, move |_| {
        BUFFERS.with(|buffers| {
            let buffers = buffers.borrow();
            let buffer = buffers
                .get(&preview_id)
                .filter(|buffer| buffer.owner == owner)
                .ok_or("Preview no longer exists")?;
            let media = buffer.media.upgrade().ok_or("Native screen closed")?;
            let mut data = std::ptr::null_mut();
            unsafe {
                buffer.shared.Buffer(&mut data).map_err(|e| e.to_string())?;
                if data.is_null() {
                    return Err("Preview buffer closed".into());
                }
                // Only this UI-thread request writes. JS reads after invoke resolves,
                // copies into a VideoFrame, then requests again. No shared mutable JS access.
                media.copy_preview_frame(after, std::slice::from_raw_parts_mut(data, BUFFER_SIZE))
            }
        })
    })
    .await
}

pub async fn close(webview: Webview, preview_id: String) -> Result<(), String> {
    let owner = webview.label().to_owned();
    on_view(webview, move |_| {
        BUFFERS.with(|buffers| {
            let mut buffers = buffers.borrow_mut();
            if buffers
                .get(&preview_id)
                .is_some_and(|buffer| buffer.owner == owner)
            {
                buffers.remove(&preview_id);
            }
        });
        Ok(())
    })
    .await
}
