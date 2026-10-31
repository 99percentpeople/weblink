//! A native view of WebView2 shared memory, independent of its UI-thread COM owner.
use std::sync::Mutex;
use windows::Win32::{
    Foundation::HANDLE,
    System::Memory::{MapViewOfFile, UnmapViewOfFile, FILE_MAP_WRITE, MEMORY_MAPPED_VIEW_ADDRESS},
};

struct Mapping {
    address: MEMORY_MAPPED_VIEW_ADDRESS,
    len: usize,
}

// SAFETY: A mapped view belongs to the process, not the creating thread. Its
// only Rust access is behind SharedFrame's mutex, and Drop unmaps it once.
unsafe impl Send for Mapping {}

impl Drop for Mapping {
    fn drop(&mut self) {
        let _ = unsafe { UnmapViewOfFile(self.address) };
    }
}

pub(super) struct SharedFrame(Mutex<Mapping>);
impl SharedFrame {
    /// The handle is borrowed only while creating our own view. Closing the
    /// WebView2 buffer cannot unmap this view while an in-flight copy owns it.
    pub fn new(handle: HANDLE, len: usize) -> Result<Self, String> {
        if len == 0 || len > weblink_desktop_capture::receive::FRAME_CAPACITY {
            return Err("Invalid receive buffer size".into());
        }
        let address = unsafe { MapViewOfFile(handle, FILE_MAP_WRITE, 0, 0, len) };
        if address.Value.is_null() {
            return Err(windows_core::Error::from_thread().to_string());
        }
        Ok(Self(Mutex::new(Mapping { address, len })))
    }

    /// Delivery publishes a slot only after this write completes, and keeps it
    /// leased until the renderer has copied its bytes into a VideoFrame.
    pub fn write<T>(
        &self,
        write: impl FnOnce(&mut [u8]) -> Result<T, String>,
    ) -> Result<T, String> {
        let mapping = self.0.lock().map_err(|_| "Receive buffer copy failed")?;
        // SAFETY: MapViewOfFile validated this extent, the mutex excludes native
        // writers, and the mapping remains owned until the closure returns.
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(mapping.address.Value.cast::<u8>(), mapping.len)
        };
        write(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{mpsc, Arc};
    use windows::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::Memory::{CreateFileMappingW, PAGE_READWRITE},
    };

    #[test]
    fn worker_writes_the_same_memory_after_the_original_handle_closes() {
        let handle = unsafe {
            CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, 64, None).unwrap()
        };
        let writer = SharedFrame::new(handle, 64).unwrap();
        let reader = SharedFrame::new(handle, 64).unwrap();
        unsafe { CloseHandle(handle).unwrap() };
        let owner_thread = std::thread::current().id();
        std::thread::spawn(move || {
            assert_ne!(std::thread::current().id(), owner_thread);
            writer
                .write(|bytes| {
                    for (index, byte) in bytes.iter_mut().enumerate() {
                        *byte = index as u8;
                    }
                    Ok(())
                })
                .unwrap();
        })
        .join()
        .unwrap();
        reader
            .write(|bytes| {
                assert_eq!(bytes, (0..64).collect::<Vec<u8>>());
                Ok(())
            })
            .unwrap();
    }

    #[test]
    fn teardown_releases_ownership_without_invalidating_an_inflight_copy() {
        let handle = unsafe {
            CreateFileMappingW(INVALID_HANDLE_VALUE, None, PAGE_READWRITE, 0, 64, None).unwrap()
        };
        let owner = Arc::new(SharedFrame::new(handle, 64).unwrap());
        unsafe { CloseHandle(handle).unwrap() };
        let weak = Arc::downgrade(&owner);
        let worker = owner.clone();
        let (entered, wait_entered) = mpsc::channel();
        let (finish, wait_finish) = mpsc::channel();
        let task = std::thread::spawn(move || {
            worker.write(|bytes| {
                entered.send(()).unwrap();
                wait_finish.recv().unwrap();
                bytes.fill(123);
                Ok(bytes.len())
            })
        });
        wait_entered.recv().unwrap();
        drop(owner);
        assert!(weak.upgrade().is_some());
        finish.send(()).unwrap();
        assert_eq!(task.join().unwrap().unwrap(), 64);
        assert!(weak.upgrade().is_none());
    }

    #[test]
    fn rejects_unavailable_or_invalid_mappings() {
        assert!(SharedFrame::new(HANDLE::default(), 64).is_err());
        assert!(SharedFrame::new(HANDLE::default(), 0).is_err());
        assert!(SharedFrame::new(HANDLE::default(), usize::MAX).is_err());
    }
}
