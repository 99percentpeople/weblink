//! Process loopback excludes Weblink and its WebView children to avoid meeting echo.
use crate::Result;
use std::{mem::ManuallyDrop, sync::mpsc, time::Duration};
use windows::{
    core::{implement, Interface, Ref, HRESULT},
    Win32::{
        Media::Audio::*,
        System::{
            Com::{StructuredStorage::*, BLOB},
            Variant::VT_BLOB,
        },
    },
};

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct Completion(mpsc::SyncSender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Completion_Impl {
    fn ActivateCompleted(
        &self,
        _: Ref<IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let _ = self.0.try_send(());
        Ok(())
    }
}

pub(super) fn excluding_current_process() -> Result<IAudioClient> {
    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // The PROPVARIANT borrows this stack blob; it must not call PropVariantClear.
    let variant = ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                        pBlobData: std::ptr::from_mut(&mut params).cast(),
                    },
                },
                ..Default::default()
            }),
        },
    });
    let (tx, rx) = mpsc::sync_channel(1);
    let completion: IActivateAudioInterfaceCompletionHandler = Completion(tx).into();
    let operation = unsafe {
        ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(&*variant),
            &completion,
        )
    }
    .map_err(|e| format!("System audio is unavailable: {e}"))?;
    rx.recv_timeout(Duration::from_secs(5))
        .map_err(|_| "System audio activation timed out".to_string())?;
    let mut status = HRESULT::default();
    let mut object = None;
    unsafe { operation.GetActivateResult(&mut status, &mut object) }.map_err(|e| e.to_string())?;
    status
        .ok()
        .map_err(|e| format!("System audio is unavailable: {e}"))?;
    object
        .ok_or("Missing system audio interface")?
        .cast()
        .map_err(|e| e.to_string())
}
