use super::{restore_error, Setting, Status, ThreadReport, ThreadRole};
use windows::{
    core::{IUnknown, Interface},
    Win32::{
        Graphics::{Direct3D11::ID3D11Device, Dxgi::IDXGIDevice},
        Media::{timeBeginPeriod, timeEndPeriod},
        System::Threading::{
            GetCurrentThread, GetThreadPriority, SetThreadPriority, THREAD_PRIORITY,
            THREAD_PRIORITY_ABOVE_NORMAL, THREAD_PRIORITY_HIGHEST,
        },
    },
};

pub(super) struct Timer;
pub(super) fn timer() -> Setting<Timer> {
    // Documented per-process request on Windows 10 2004+. No periodic wakeup loop.
    let result = unsafe { timeBeginPeriod(1) };
    Setting::from_result(if result == 0 {
        Ok(Some(Timer))
    } else {
        Err(format!("timeBeginPeriod(1): {result}"))
    })
}
impl Drop for Timer {
    fn drop(&mut self) {
        let result = unsafe { timeEndPeriod(1) };
        if result != 0 {
            restore_error("timer resolution", result);
        }
    }
}

struct Priority {
    previous: i32,
    applied: i32,
}
impl Priority {
    fn enter(role: ThreadRole) -> Result<Option<Self>, String> {
        let previous = thread_priority()?;
        let applied = match role {
            ThreadRole::Capture => THREAD_PRIORITY_ABOVE_NORMAL.0,
            ThreadRole::Encode => THREAD_PRIORITY_HIGHEST.0,
        };
        if previous >= applied {
            return Ok(None);
        }
        unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(applied)) }
            .map_err(|e| e.to_string())?;
        let guard = Self { previous, applied };
        if thread_priority()? != applied {
            return Err("Windows did not retain the thread priority".into());
        }
        Ok(Some(guard))
    }
}
fn thread_priority() -> Result<i32, String> {
    let priority = unsafe { GetThreadPriority(GetCurrentThread()) };
    if priority == i32::MAX {
        Err(windows::core::Error::from_thread().to_string())
    } else {
        Ok(priority)
    }
}
impl Drop for Priority {
    fn drop(&mut self) {
        // Do not undo a later change made by the worker's actual owner.
        match thread_priority() {
            Ok(current) if current == self.applied => {
                if let Err(error) =
                    unsafe { SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY(self.previous)) }
                {
                    restore_error("thread priority", error);
                }
            }
            Err(error) => restore_error("thread priority", error),
            _ => {}
        }
    }
}
pub(super) struct Thread {
    priority: Setting<Priority>,
}
impl Thread {
    pub fn enter(role: ThreadRole) -> Self {
        Self {
            priority: Setting::from_result(Priority::enter(role)),
        }
    }
    pub fn report(&self) -> ThreadReport {
        ThreadReport {
            scheduling: self.priority.status.clone(),
            timing: Status::Unsupported,
        }
    }
}

pub(super) struct Gpu {
    device: IDXGIDevice,
    previous: i32,
}
pub(super) fn device_key(device: &ID3D11Device) -> Result<usize, String> {
    device
        .cast::<IUnknown>()
        .map(|identity| identity.as_raw() as usize)
        .map_err(|e| e.to_string())
}
pub(super) fn gpu(device: &ID3D11Device) -> Setting<Gpu> {
    Setting::from_result((|| {
        let device: IDXGIDevice = device.cast().map_err(|e| e.to_string())?;
        let previous = unsafe { device.GetGPUThreadPriority() }.map_err(|e| e.to_string())?;
        // Preserve stronger/absolute preferences. Request only relative priority;
        // no realtime process GPU class, administrator requirement or clock lock.
        if previous >= 7 {
            return Ok(None);
        }
        unsafe { device.SetGPUThreadPriority(7) }.map_err(|e| e.to_string())?;
        let guard = Gpu { device, previous };
        if unsafe { guard.device.GetGPUThreadPriority() }.map_err(|e| e.to_string())? != 7 {
            return Err("DXGI did not retain GPU thread priority".into());
        }
        Ok(Some(guard))
    })())
}
impl Drop for Gpu {
    fn drop(&mut self) {
        match unsafe { self.device.GetGPUThreadPriority() } {
            Ok(7) => {
                if let Err(error) = unsafe { self.device.SetGPUThreadPriority(self.previous) } {
                    restore_error("GPU thread priority", error);
                }
            }
            Err(error) => restore_error("GPU thread priority", error),
            _ => {}
        }
    }
}
