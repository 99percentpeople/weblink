//! Platform-independent input device ownership. One manager belongs to one input
//! authority; only that authority may feed it after checking the current grant.
use crate::{engine::Device, input::Error};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Keyboard,
    Mouse,
    Touchpad,
    Touchscreen,
    Gamepad,
}
impl Kind {
    pub const ALL: [Self; 5] = [
        Self::Keyboard,
        Self::Mouse,
        Self::Touchpad,
        Self::Touchscreen,
        Self::Gamepad,
    ];
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Availability {
    Available,
    Unsupported,
    DriverRequired,
    Unavailable,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Driver {
    pub name: String,
    pub install_url: String,
    pub maintenance: String,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capability {
    pub kind: Kind,
    pub availability: Availability,
    pub max_devices: u8,
    /// Absent for system-provided injection. A missing optional driver must not
    /// disable the other input backends or require elevation of the application.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub driver: Option<Driver>,
}
impl Capability {
    pub fn system(kind: Kind, available: bool) -> Self {
        Self {
            kind,
            availability: if available {
                Availability::Available
            } else {
                Availability::Unsupported
            },
            max_devices: u8::from(available),
            driver: None,
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct Key {
    pub kind: Kind,
    pub slot: u8,
}
impl Key {
    pub fn single(kind: Kind) -> Self {
        Self { kind, slot: 0 }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum State {
    Mounted,
    Suspended,
    Failed,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MountedDevice {
    pub kind: Kind,
    pub slot: u8,
    pub state: State,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub capabilities: Vec<Capability>,
    pub mounted: Vec<MountedDevice>,
}

pub struct Manager<D: Device> {
    pub(crate) backend: D,
    mounted: BTreeMap<Key, State>,
    gamepads: BTreeMap<u8, (String, Option<Instant>)>,
}
impl<D: Device> Manager<D> {
    pub fn gamepad_feedback(&mut self, now: Instant) -> Vec<(u8, String, crate::gamepad::Rumble)> {
        self.backend
            .gamepad_feedback()
            .into_iter()
            .filter_map(|(slot, rumble)| {
                let (id, at) = self.gamepads.get(&slot)?;
                let key = Key {
                    kind: Kind::Gamepad,
                    slot,
                };
                (self.mounted.get(&key) == Some(&State::Mounted)
                    && at.is_some_and(|at| {
                        now.saturating_duration_since(at) < crate::gamepad::STALE_AFTER
                    }))
                .then(|| (slot, id.clone(), rumble))
            })
            .collect()
    }
    pub fn new(backend: D) -> Self {
        Self {
            backend,
            mounted: BTreeMap::new(),
            gamepads: BTreeMap::new(),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        Snapshot {
            capabilities: self.backend.capabilities(),
            mounted: self
                .mounted
                .iter()
                .map(|(key, state)| MountedDevice {
                    kind: key.kind,
                    slot: key.slot,
                    state: *state,
                })
                .collect(),
        }
    }
    pub fn ensure(&mut self, key: Key) -> Result<(), Error> {
        if let Some(state) = self.mounted.get_mut(&key) {
            if *state == State::Failed {
                return Err(Error::Release);
            }
            *state = State::Mounted;
            return Ok(());
        }
        if !self.backend.capabilities().iter().any(|c| {
            c.kind == key.kind
                && c.availability == Availability::Available
                && key.slot < c.max_devices
        }) {
            return Err(Error::Unavailable);
        }
        // Own the attempt before calling the backend: partial creation and panic
        // must still be covered by authority/manager cleanup.
        self.mounted.insert(key, State::Failed);
        self.backend.mount(key)?;
        self.mounted.insert(key, State::Mounted);
        Ok(())
    }
    pub fn suspend(&mut self) {
        for state in self.mounted.values_mut() {
            if *state != State::Failed {
                *state = State::Suspended;
            }
        }
    }
    pub fn unmount(&mut self, key: Key) -> bool {
        if !self.mounted.contains_key(&key) {
            return true;
        }
        self.mounted.insert(key, State::Failed);
        let released =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.backend.unmount(key)))
                .is_ok_and(|r| r.is_ok());
        if released {
            self.mounted.remove(&key);
            if key.kind == Kind::Gamepad {
                self.gamepads.remove(&key.slot);
            }
        }
        released
    }
    pub fn gamepad(&mut self, event: crate::gamepad::Event, now: Instant) -> Result<(), Error> {
        use crate::gamepad::Event;
        if !event.valid() {
            return Err(Error::Invalid);
        }
        let (slot, id) = event.identity();
        let key = Key {
            kind: Kind::Gamepad,
            slot,
        };
        let matches = self
            .gamepads
            .get(&slot)
            .is_some_and(|(current, _)| current == id);
        match event {
            Event::Connect { id, .. } => {
                if matches {
                    return Ok(());
                }
                if !self.unmount(key) {
                    return Err(Error::Release);
                }
                if let Err(error) = self.ensure(key) {
                    return if self.unmount(key) {
                        Err(error)
                    } else {
                        Err(Error::Release)
                    };
                }
                self.gamepads.insert(slot, (id, Some(now)));
                Ok(())
            }
            Event::Disconnect { .. } if matches => {
                if self.unmount(key) {
                    Ok(())
                } else {
                    Err(Error::Release)
                }
            }
            Event::State { state, .. } if matches => {
                if self.backend.submit_gamepad(slot, state).is_err() {
                    return if self.unmount(key) {
                        Err(Error::Unavailable)
                    } else {
                        Err(Error::Release)
                    };
                }
                self.gamepads.get_mut(&slot).unwrap().1 = Some(now);
                self.mounted.insert(key, State::Mounted);
                Ok(())
            }
            // Old unplug/update messages can never affect a replacement pad.
            _ => Ok(()),
        }
    }
    pub fn reset_gamepads(&mut self) -> bool {
        let slots: Vec<_> = self.gamepads.keys().copied().collect();
        let mut ok = true;
        for slot in slots {
            ok &= self.neutralize(slot);
        }
        ok
    }
    pub fn release_gamepads(&mut self) -> bool {
        let mut ok = self.reset_gamepads();
        let keys: Vec<_> = self
            .mounted
            .keys()
            .filter(|key| key.kind == Kind::Gamepad)
            .copied()
            .collect();
        for key in keys {
            ok &= self.unmount(key);
        }
        ok
    }
    fn neutralize(&mut self, slot: u8) -> bool {
        let ok = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            self.backend.reset_gamepad_feedback(slot);
            self.backend
                .submit_gamepad(slot, crate::gamepad::State::default())
        }))
        .is_ok_and(|r| r.is_ok());
        let key = Key {
            kind: Kind::Gamepad,
            slot,
        };
        if ok {
            self.gamepads.get_mut(&slot).unwrap().1 = None;
            self.mounted.insert(key, State::Suspended);
            true
        } else {
            self.unmount(key)
        }
    }
    pub fn expire_gamepads(&mut self, now: Instant) -> bool {
        let expired: Vec<_> = self
            .gamepads
            .iter()
            .filter_map(|(slot, (_, at))| {
                at.filter(|at| now.saturating_duration_since(*at) >= crate::gamepad::STALE_AFTER)
                    .map(|_| *slot)
            })
            .collect();
        let mut ok = true;
        for slot in expired {
            ok &= self.neutralize(slot);
        }
        ok
    }
    pub fn unmount_all(&mut self) -> bool {
        let keys: Vec<_> = self.mounted.keys().copied().collect();
        let mut ok = true;
        for key in keys {
            ok &= self.unmount(key);
        }
        ok
    }
}
impl<D: Device> Drop for Manager<D> {
    fn drop(&mut self) {
        self.unmount_all();
    }
}
