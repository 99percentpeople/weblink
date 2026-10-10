//! Optional ViGEmBus backend. No installer, service, DLL loading or elevation is
//! performed by Weblink. Driver access is probed without creating a controller.
use crate::{
    devices::{Availability, Capability, Driver, Kind},
    gamepad::{Rumble, State, MAX_GAMEPADS},
    input::Error,
};
use std::{
    collections::BTreeMap,
    pin::Pin,
    time::{Duration, Instant},
};
use vigem_client::{Client, TargetId, XButtons, XGamepad, XRequestNotification, Xbox360Wired};

struct Pad {
    // Drop the pinned request first: cancellation must complete before the
    // OVERLAPPED buffer is freed, even on partial mount or panic cleanup.
    notification: Option<Pin<Box<XRequestNotification>>>,
    target: Xbox360Wired<Client>,
    created: Instant,
    ready: bool,
    rumble: Rumble,
    notification_failed: bool,
}
impl Pad {
    fn starting(&self, error: vigem_client::Error) -> bool {
        !self.ready
            && self.created.elapsed() < Duration::from_secs(2)
            && matches!(
                error,
                vigem_client::Error::TargetNotReady | vigem_client::Error::WinError(170)
            )
    }
    fn listen(&mut self) {
        if self.notification.is_some() || self.notification_failed {
            return;
        }
        match self.target.request_notification() {
            Ok(request) => {
                let mut request = Box::pin(request);
                request.as_mut().request();
                self.notification = Some(request);
            }
            Err(_) => self.notification_failed = true,
        }
    }
    fn feedback(&mut self) -> Rumble {
        if let Some(request) = self.notification.as_mut() {
            // Bound work under a noisy game. Never wait on driver output in the
            // input actor: keyboard release and authorization must stay responsive.
            for _ in 0..8 {
                match request.as_mut().poll(false) {
                    Ok(Some(value)) => {
                        self.rumble = Rumble {
                            strong: value.large_motor,
                            weak: value.small_motor,
                        };
                        request.as_mut().request();
                    }
                    Ok(None) => break,
                    Err(_) => {
                        self.notification_failed = true;
                        self.rumble = Rumble::default();
                        break;
                    }
                }
            }
        }
        if self.notification_failed {
            self.notification = None;
        }
        self.rumble
    }
}

pub(super) struct GamepadDevice {
    availability: Availability,
    pads: BTreeMap<u8, Pad>,
}
impl GamepadDevice {
    pub fn reset_feedback(&mut self, slot: u8) {
        if let Some(pad) = self.pads.get_mut(&slot) {
            pad.notification = None;
            pad.rumble = Rumble::default();
        }
    }
    pub fn feedback(&mut self) -> Vec<(u8, Rumble)> {
        self.pads
            .iter_mut()
            .map(|(slot, pad)| (*slot, pad.feedback()))
            .collect()
    }
    pub fn new() -> Self {
        let mut device = Self {
            availability: Availability::Unavailable,
            pads: BTreeMap::new(),
        };
        device.refresh();
        device
    }
    pub fn refresh(&mut self) {
        self.availability = match Client::connect() {
            Ok(_) => Availability::Available,
            Err(vigem_client::Error::BusNotFound) => Availability::DriverRequired,
            Err(_) => Availability::Unavailable,
        };
    }
    pub fn capability(&self) -> Capability {
        Capability {
            kind: Kind::Gamepad,
            availability: self.availability,
            max_devices: MAX_GAMEPADS,
            driver: Some(Driver {
                name: "ViGEmBus".into(),
                install_url: "https://docs.nefarius.at/projects/ViGEm/How-to-Install/".into(),
                maintenance: "retired".into(),
            }),
        }
    }
    pub fn mount(&mut self, slot: u8) -> Result<(), Error> {
        if slot >= MAX_GAMEPADS {
            return Err(Error::Invalid);
        }
        if self.pads.contains_key(&slot) {
            return Ok(());
        }
        let client = Client::connect().map_err(|error| {
            eprintln!("[gamepad] slot {slot}: could not connect to ViGEmBus: {error}");
            Error::Unavailable
        })?;
        // Retain ownership even if creation partially fails.
        let pad = self.pads.entry(slot).or_insert_with(|| Pad {
            target: Xbox360Wired::new(client, TargetId::XBOX360_WIRED),
            created: Instant::now(),
            ready: false,
            notification: None,
            rumble: Rumble::default(),
            notification_failed: false,
        });
        pad.target.plugin().map_err(|error| {
            eprintln!("[gamepad] slot {slot}: could not mount Xbox 360 target: {error}");
            Error::Unavailable
        })
    }
    pub fn submit(&mut self, slot: u8, state: State) -> Result<(), Error> {
        let pad = self.pads.get_mut(&slot).ok_or(Error::Unavailable)?;
        match pad.target.update(&report(state)) {
            Ok(()) => {
                pad.ready = true;
                pad.listen();
                Ok(())
            }
            // PnP creation is asynchronous. Never wait_ready on the input actor:
            // keyboard release and the authorization lease must keep running.
            // Windows can also return ERROR_BUSY (170) immediately after plug-in.
            // Only tolerate it before the first accepted report; once input has
            // been sent, a failed neutral/release report must still fail closed.
            Err(error) if pad.starting(error) => Ok(()),
            Err(error) => {
                eprintln!("[gamepad] slot {slot}: could not submit Xbox 360 state: {error}");
                Err(Error::Unavailable)
            }
        }
    }
    pub fn unmount(&mut self, slot: u8) -> Result<(), Error> {
        if let Some(pad) = self.pads.get_mut(&slot) {
            pad.notification = None;
            if pad.target.is_attached() {
                let _ = pad.target.update(&XGamepad::default());
                pad.target.unplug().map_err(|_| Error::Release)?;
            }
        }
        self.pads.remove(&slot);
        Ok(())
    }
}
fn report(state: State) -> XGamepad {
    // W3C standard gamepad order -> XInput bit flags. Trigger buttons are analog.
    const BUTTONS: [u16; 17] = [
        0x1000, 0x2000, 0x4000, 0x8000, 0x100, 0x200, 0, 0, 0x20, 0x10, 0x40, 0x80, 1, 2, 4, 8,
        0x400,
    ];
    let buttons = BUTTONS.iter().enumerate().fold(0, |bits, (i, mask)| {
        bits | if state.buttons & (1 << i) != 0 {
            *mask
        } else {
            0
        }
    });
    let axis = |value: f32| (value * if value < 0.0 { 32768.0 } else { 32767.0 }).round() as i16;
    XGamepad {
        buttons: XButtons { raw: buttons },
        left_trigger: (state.triggers[0] * 255.0).round() as u8,
        right_trigger: (state.triggers[1] * 255.0).round() as u8,
        thumb_lx: axis(state.axes[0]),
        thumb_ly: axis(-state.axes[1]),
        thumb_rx: axis(state.axes[2]),
        thumb_ry: axis(-state.axes[3]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires installed ViGEmBus; repeatedly creates a neutral controller"]
    fn native_driver_repeated_immediate_reports() {
        let mut backend = GamepadDevice::new();
        let mut deferred = 0;
        for attempt in 0..40 {
            backend.mount(0).unwrap();
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                backend.submit(0, State::default()).unwrap_or_else(|error| {
                    panic!("first report failed on mount {attempt}: {error:?}")
                });
                if backend.pads.get(&0).unwrap().ready {
                    break;
                }
                deferred += 1;
                assert!(
                    Instant::now() < deadline,
                    "target never became ready on mount {attempt}"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
            // A successful first report ends the grace period, even if it was
            // accepted well before the startup deadline.
            assert!(!backend
                .pads
                .get(&0)
                .unwrap()
                .starting(vigem_client::Error::WinError(170)));
            backend.unmount(0).unwrap();
            assert!(backend.pads.is_empty());
        }
        eprintln!("40 mount/report/unmount cycles passed; {deferred} startup reports deferred");
    }
    #[test]
    #[ignore = "Requires installed ViGEmBus and one free XInput slot; briefly creates a neutral controller"]
    fn native_driver_mount_feedback_and_unmount() {
        use windows::Win32::UI::Input::XboxController::{
            XInputGetState, XInputSetState, XINPUT_STATE, XINPUT_VIBRATION,
        };
        let mut backend = GamepadDevice::new();
        assert_eq!(backend.capability().availability, Availability::Available);
        backend.mount(0).unwrap();
        let start = Instant::now();
        let index = loop {
            // Browser sampling starts immediately after connect, before Windows
            // has necessarily finished enumerating the virtual controller.
            backend.submit(0, State::default()).unwrap();
            if let Ok(index) = backend.pads.get_mut(&0).unwrap().target.get_user_index() {
                break index;
            }
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "XInput target did not become ready"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        backend.submit(0, State::default()).unwrap();
        let mut state = XINPUT_STATE::default();
        assert_eq!(unsafe { XInputGetState(index, &mut state) }, 0);
        assert_eq!(state.Gamepad.wButtons.0, 0);
        assert_eq!(
            (state.Gamepad.bLeftTrigger, state.Gamepad.bRightTrigger),
            (0, 0)
        );
        for speed in [u16::MAX, 0] {
            let vibration = XINPUT_VIBRATION {
                wLeftMotorSpeed: speed,
                wRightMotorSpeed: 0,
            };
            assert_eq!(unsafe { XInputSetState(index, &vibration) }, 0);
            let start = Instant::now();
            loop {
                let feedback = backend.feedback();
                if feedback
                    == vec![(
                        0,
                        Rumble {
                            strong: if speed == 0 { 0 } else { 255 },
                            weak: 0,
                        },
                    )]
                {
                    break;
                }
                assert!(
                    start.elapsed() < Duration::from_secs(2),
                    "driver output notification missing: {feedback:?}"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        // An outstanding notification must be cancelled by unmount, not leak a
        // reader or keep the virtual device attached.
        backend.unmount(0).unwrap();
        let start = Instant::now();
        while unsafe { XInputGetState(index, &mut state) } == 0 {
            assert!(
                start.elapsed() < Duration::from_secs(5),
                "XInput target remained after unplug"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(backend.pads.is_empty());
    }
    #[test]
    fn standard_mapping_preserves_triggers_and_inverts_vertical_axes() {
        let native = report(State {
            buttons: (1 << 0) | (1 << 12) | (1 << 6),
            axes: [-1.0, 1.0, 1.0, -1.0],
            triggers: [1.0, 0.5],
        });
        assert_eq!(native.buttons.raw, 0x1001);
        assert_eq!((native.left_trigger, native.right_trigger), (255, 128));
        assert_eq!(
            (
                native.thumb_lx,
                native.thumb_ly,
                native.thumb_rx,
                native.thumb_ry
            ),
            (-32768, -32768, 32767, 32767)
        );
    }
}
