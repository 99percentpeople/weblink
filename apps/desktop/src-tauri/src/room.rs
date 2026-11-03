//! The main WebView owns its peer handles. Closing a peer releases SCTP and all RTP outputs.
#[cfg(any(windows, test))]
mod batch;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(not(windows))]
mod unsupported {
    #[derive(Default)]
    pub struct Service;
    impl Service {
        pub fn clear(&self, _: Option<&str>) {}
    }
    macro_rules! unavailable { ($($name:ident),*) => {$(
        #[tauri::command] pub fn $name()->Result<(),String>{Err("Native room transport unavailable".into())}
    )*} }
    unavailable!(
        room_screen,
        room_open,
        room_operation,
        room_write,
        room_audio
    );
}
#[cfg(not(windows))]
pub use unsupported::*;
