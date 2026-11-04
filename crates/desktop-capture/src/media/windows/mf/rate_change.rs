//! Prepare a rate-latched MFT while its predecessor continues encoding.
use super::{
    encoders::Selection,
    transform::{Configuration, Runtime, Transform},
};
use crate::{surface::gpu::Wake, Result};
use std::{
    sync::mpsc::{self, Receiver, TryRecvError},
    thread,
    time::{Duration, Instant},
};
use windows::Win32::Graphics::Direct3D11::ID3D11Device;

// The two private channel endpoints live in the process's same COM MTA.
// Ownership moves exactly once. No thread can call or release the instance
// concurrently, and each endpoint holds a Runtime until its last release.
struct MtaTransfer(Transform);
unsafe impl Send for MtaTransfer {}

pub(in crate::media::windows) struct Warmup {
    pub bitrate: u32,
    started: Instant,
    receive: Receiver<Result<MtaTransfer>>,
    candidate: Option<Transform>,
}

impl Warmup {
    pub fn start(
        mut selection: Selection,
        config: Configuration,
        device: Option<ID3D11Device>,
        wake: Wake,
        _owner: &Runtime,
    ) -> Result<Self> {
        let started = Instant::now();
        let (send, receive) = mpsc::sync_channel(1);
        thread::Builder::new()
            .name("mf-rate-change".into())
            .spawn(move || {
                let runtime = Runtime::new();
                let prepared = runtime.as_ref().map_err(|e| e.to_string()).and_then(|_| {
                    selection
                        .open(
                            config.width,
                            config.height,
                            config.fps,
                            config.bitrate,
                            config.bitrate_limit,
                            config.color,
                            wake.clone(),
                            device.as_ref(),
                        )
                        .map(MtaTransfer)
                });
                // A closed receiver cancels the handoff and releases the MFT here,
                // before the helper leaves the apartment.
                drop(send.send(prepared));
                wake();
            })
            .map_err(|e| e.to_string())?;
        Ok(Self {
            bitrate: config.bitrate,
            started,
            receive,
            candidate: None,
        })
    }

    #[cfg(test)]
    pub fn unavailable(bitrate: u32) -> Self {
        let (send, receive) = mpsc::sync_channel(1);
        send.send(Err("Only one hardware session is available".into()))
            .unwrap();
        Self {
            bitrate,
            started: Instant::now(),
            receive,
            candidate: None,
        }
    }

    pub fn take_ready(&mut self, _owner: &Runtime) -> Result<Option<Transform>> {
        if self.candidate.is_none() {
            match self.receive.try_recv() {
                Ok(result) => self.candidate = Some(result?.0),
                Err(TryRecvError::Empty) => return self.pending(),
                Err(TryRecvError::Disconnected) => {
                    return Err("MF rate change worker stopped".into())
                }
            }
        }
        let transform = self.candidate.as_mut().unwrap();
        // The asynchronous MFT may have opened without asking for its first
        // input yet. Its event callback will wake the active worker again.
        transform.poll().map_err(|e| e.to_string())?;
        if transform.ready() {
            Ok(self.candidate.take())
        } else {
            self.pending()
        }
    }
    fn pending(&self) -> Result<Option<Transform>> {
        // The driver can accept activation yet never grant a second input
        // session. Use the same readiness window as encoder group migration.
        if self.started.elapsed() >= Duration::from_secs(3) {
            Err("Concurrent MF encoder did not become ready".into())
        } else {
            Ok(None)
        }
    }
}
