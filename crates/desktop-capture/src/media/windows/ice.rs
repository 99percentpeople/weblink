//! Sticky, per-peer ICE completion and cancellation; callbacks may precede waits.
use crate::Result;
use tokio::sync::watch;

#[derive(Clone, Copy, PartialEq, Eq)]
enum State {
    Pending,
    Complete,
    Closed,
}

pub(super) struct Gathering(watch::Sender<State>);
impl Gathering {
    pub fn new() -> Self {
        Self(watch::channel(State::Pending).0)
    }
    pub fn complete(&self) {
        self.0.send_if_modified(|state| {
            if *state != State::Pending {
                return false;
            }
            *state = State::Complete;
            true
        });
    }
    pub fn close(&self) {
        self.0.send_replace(State::Closed);
    }
    pub async fn wait(&self) -> Result<()> {
        let mut receiver = self.0.subscribe();
        let state = *receiver
            .wait_for(|state| *state != State::Pending)
            .await
            .map_err(|_| "Native media connection closed".to_string())?;
        match state {
            State::Complete => Ok(()),
            _ => Err("Native media connection closed".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        future::{poll_fn, Future},
        task::Poll,
        time::Duration,
    };

    #[test]
    fn completion_before_wait_is_retained_and_late_completion_cannot_reopen_a_peer() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let gathering = Gathering::new();
            gathering.complete();
            assert!(gathering.wait().await.is_ok());
            gathering.close();
            gathering.complete();
            assert!(gathering.wait().await.is_err());
        });
    }

    #[test]
    fn completion_and_cancellation_wake_registered_waiters_independently() {
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let first = Gathering::new();
            let second = Gathering::new();
            let mut waiting_first = Box::pin(first.wait());
            let mut waiting_second = Box::pin(second.wait());
            poll_fn(|cx| {
                assert!(waiting_first.as_mut().poll(cx).is_pending());
                assert!(waiting_second.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            first.complete();
            assert!(tokio::time::timeout(Duration::from_secs(1), waiting_first)
                .await
                .unwrap()
                .is_ok());
            poll_fn(|cx| {
                assert!(waiting_second.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            second.close();
            second.complete();
            assert!(tokio::time::timeout(Duration::from_secs(1), waiting_second)
                .await
                .unwrap()
                .is_err());
        });
    }
}
