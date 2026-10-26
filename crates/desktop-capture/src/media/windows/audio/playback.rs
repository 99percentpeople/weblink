//! Playback endpoint mute leases, independent of the process-loopback sender.
use crate::Result;
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
};
use windows::Win32::{
    Media::Audio::{
        eRender, Endpoints::IAudioEndpointVolume, IMMDeviceEnumerator, MMDeviceEnumerator,
        DEVICE_STATE_ACTIVE,
    },
    System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL},
};

pub(super) trait Endpoint {
    fn muted(&self) -> Result<bool>;
    fn set_muted(&self, muted: bool) -> Result<()>;
}

impl Endpoint for IAudioEndpointVolume {
    fn muted(&self) -> Result<bool> {
        unsafe { self.GetMute() }
            .map(|value| value.as_bool())
            .map_err(|e| e.to_string())
    }
    fn set_muted(&self, muted: bool) -> Result<()> {
        unsafe { self.SetMute(muted, std::ptr::null()) }.map_err(|e| e.to_string())
    }
}

struct Entry {
    was_muted: bool,
    users: usize,
}

type Registry = Mutex<HashMap<String, Entry>>;
static ENDPOINTS: LazyLock<Registry> = LazyLock::new(Mutex::default);

// The registry serializes mute/restore with new leases. A replacement capture
// must not snapshot the old capture's temporary mute as the original state.
pub(super) struct PlaybackMute<'a, E: Endpoint = IAudioEndpointVolume> {
    registry: &'a Registry,
    // Each worker owns its own COM interfaces; only counts/state cross threads.
    endpoints: Vec<(String, E)>,
}

impl<'a, E: Endpoint> PlaybackMute<'a, E> {
    fn acquire(registry: &'a Registry, endpoints: Vec<(String, E)>) -> Result<Self> {
        let mut lease = Self {
            registry,
            endpoints: Vec::new(),
        };
        for (id, endpoint) in endpoints {
            let mut entries = registry.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(entry) = entries.get_mut(&id) {
                entry.users += 1;
            } else {
                let was_muted = endpoint.muted()?;
                if !was_muted {
                    endpoint.set_muted(true)?;
                }
                entries.insert(
                    id.clone(),
                    Entry {
                        was_muted,
                        users: 1,
                    },
                );
            }
            lease.endpoints.push((id, endpoint));
        }
        Ok(lease)
    }
}

impl<E: Endpoint> Drop for PlaybackMute<'_, E> {
    fn drop(&mut self) {
        let mut entries = self.registry.lock().unwrap_or_else(|e| e.into_inner());
        for (id, endpoint) in &self.endpoints {
            let Some(entry) = entries.get_mut(id) else {
                continue;
            };
            entry.users -= 1;
            if entry.users != 0 {
                continue;
            }
            let entry = entries.remove(id).unwrap();
            // Leave an already-muted output alone, and respect a manual unmute.
            // A failed status read must not prevent a best-effort restoration.
            if !entry.was_muted && endpoint.muted().unwrap_or(true) {
                if let Err(error) = endpoint.set_muted(false) {
                    eprintln!("Could not restore local audio playback: {error}");
                }
            }
        }
    }
}

pub(super) fn mute() -> Result<PlaybackMute<'static>> {
    let endpoints =
        playback_endpoints().map_err(|e| format!("Could not mute local audio playback: {e}"))?;
    PlaybackMute::acquire(&ENDPOINTS, endpoints)
        .map_err(|e| format!("Could not mute local audio playback: {e}"))
}

fn playback_endpoints() -> windows::core::Result<Vec<(String, IAudioEndpointVolume)>> {
    // Process loopback includes every playback device, so mute all active
    // outputs, including apps routed away from the Windows default output.
    let enumerator: IMMDeviceEnumerator =
        unsafe { CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) }?;
    let devices = unsafe { enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) }?;
    let mut endpoints = Vec::new();
    for index in 0..unsafe { devices.GetCount() }? {
        let device = unsafe { devices.Item(index) }?;
        let id = unsafe { device.GetId() }?;
        let name = unsafe { id.to_string() };
        unsafe { CoTaskMemFree(Some(id.0.cast())) };
        let volume = unsafe { device.Activate(CLSCTX_ALL, None) }?;
        endpoints.push((name?, volume));
    }
    Ok(endpoints)
}

#[cfg(test)]
mod tests;
