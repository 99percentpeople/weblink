//! Shared-buffer COM owners stay on the WebView thread.
use super::{
    delivery::{Delivery, SLOT_COUNT},
    shared_frame::SharedFrame,
};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{Arc, Weak},
};
use weblink_desktop_capture::receive::FRAME_CAPACITY;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
};
use windows_core::{Interface, HSTRING};

struct Buffers {
    owner: String,
    delivery: Weak<Delivery>,
    web: ICoreWebView2_17,
    shared: Vec<ICoreWebView2SharedBuffer>,
}
impl Drop for Buffers {
    fn drop(&mut self) {
        unsafe {
            for shared in &self.shared {
                let _ = shared.Close();
            }
        }
    }
}
thread_local! { static BUFFERS: RefCell<HashMap<String, Buffers>> = RefCell::new(HashMap::new()); }

pub(super) fn create(
    view: tauri::webview::PlatformWebview,
    owner: String,
    id: String,
    delivery: Arc<Delivery>,
) -> Result<(), String> {
    unsafe {
        let env: ICoreWebView2Environment12 =
            view.environment().cast().map_err(|e| e.to_string())?;
        let web: ICoreWebView2_17 = view
            .controller()
            .CoreWebView2()
            .and_then(|w| w.cast())
            .map_err(|e| e.to_string())?;
        let mut buffers = Buffers {
            owner,
            delivery: Arc::downgrade(&delivery),
            web,
            shared: vec![],
        };
        let mut mapped = Vec::with_capacity(SLOT_COUNT);
        for _ in 0..SLOT_COUNT {
            let shared = env
                .CreateSharedBuffer(FRAME_CAPACITY as u64)
                .map_err(|e| e.to_string())?;
            buffers.shared.push(shared.clone());
            let mut handle = windows::Win32::Foundation::HANDLE::default();
            shared
                .FileMappingHandle(&mut handle)
                .map_err(|e| e.to_string())?;
            mapped.push(Arc::new(SharedFrame::new(handle, FRAME_CAPACITY)?));
        }
        delivery.attach(
            mapped
                .try_into()
                .map_err(|_| "Invalid receive buffer pool")?,
        )?;
        for (slot, shared) in buffers.shared.iter().enumerate() {
            let metadata = HSTRING::from(serde_json::json!({"kind":"weblink-receive","id":id,"slot":slot,"slots":SLOT_COUNT}).to_string());
            buffers
                .web
                .PostSharedBufferToScript(
                    shared,
                    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY,
                    &metadata,
                )
                .map_err(|e| e.to_string())?;
        }
        BUFFERS.with(|all| all.borrow_mut().insert(id, buffers));
        Ok(())
    }
}
pub(super) fn remove(owner: &str, id: &str, delivery: &Arc<Delivery>) {
    BUFFERS.with(|all| {
        let mut all = all.borrow_mut();
        if all
            .get(id)
            .is_some_and(|b| b.owner == owner && b.delivery.ptr_eq(&Arc::downgrade(delivery)))
        {
            all.remove(id);
        }
    });
}
pub(super) fn clear(owner: &str) {
    BUFFERS.with(|all| all.borrow_mut().retain(|_, b| b.owner != owner));
}
