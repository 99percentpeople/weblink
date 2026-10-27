//! The only selection point for native backends and their event runtimes.
use crate::{
    worker::{Notify, Work},
    Capabilities, Error, Result,
};
use std::sync::mpsc::Receiver;

pub(crate) fn capabilities() -> Capabilities {
    #[cfg(windows)]
    {
        crate::windows::Windows::CAPABILITIES
    }
    #[cfg(not(windows))]
    {
        Capabilities::UNSUPPORTED
    }
}

pub(crate) fn start(receiver: Receiver<Work>) -> Result<Notify> {
    #[cfg(windows)]
    {
        std::thread::Builder::new()
            .name("accessibility".into())
            .spawn(move || {
                // UIA delivers callbacks on COM threads; this MTA needs no message pump.
                crate::runtime::run(
                    crate::runtime::BlockingQueue::new(receiver),
                    crate::windows::Windows::new,
                );
            })
            .map(|_| std::sync::Arc::new(|| {}) as Notify)
            .map_err(|_| Error::ProviderUnavailable)
    }
    #[cfg(not(windows))]
    {
        let _ = receiver;
        Err(Error::Unsupported)
    }
}
