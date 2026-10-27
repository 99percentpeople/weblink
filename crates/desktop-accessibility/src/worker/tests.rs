use super::*;
use std::sync::atomic::AtomicUsize;

fn access() -> Access {
    let check: Check = Arc::new(|| Ok(()));
    Access {
        owner: "test".into(),
        check: check.clone(),
        lease: check,
    }
}
fn unsupported_start(_: mpsc::Receiver<Work>) -> Result<Notify> {
    panic!("must not start")
}

#[test]
fn unsupported_capabilities_do_not_start_a_worker_or_guess_features() {
    let client = Client {
        worker: OnceLock::new(),
        capabilities: Capabilities::UNSUPPORTED,
        start: unsupported_start,
    };
    assert_eq!(
        client.call(Request::Capabilities, access()).unwrap(),
        json!({ "supported": false, "backend": null, "actions": [] })
    );
    assert_eq!(
        client.call(Request::Windows { limit: 1 }, access()),
        Err(Error::Unsupported)
    );
    assert!(client.worker.get().is_none());
}

#[test]
fn bounded_queue_cancels_timed_out_work_and_notifies_native_loop_on_enqueue_and_close() {
    let (tx, rx) = mpsc::sync_channel(4);
    let wakes = Arc::new(AtomicUsize::new(0));
    let count = wakes.clone();
    let client = Client {
        worker: OnceLock::from(Ok(Connection {
            sender: Some(tx),
            notify: Arc::new(move || {
                count.fetch_add(1, Ordering::SeqCst);
            }),
        })),
        capabilities: Capabilities::UNSUPPORTED,
        start: unsupported_start,
    };
    for _ in 0..4 {
        assert!(matches!(
            client.submit(
                Operation::Call(Request::Capabilities),
                access(),
                Duration::from_millis(2)
            ),
            Err(Error::Timeout)
        ));
    }
    assert!(matches!(
        client.submit(
            Operation::Call(Request::Capabilities),
            access(),
            Duration::from_secs(1)
        ),
        Err(Error::Busy)
    ));
    let signal = Arc::new(WaitSignal::default());
    drop(WaitCleanup {
        client: &client,
        signal: signal.clone(),
        access: access(),
    });
    assert!(signal.is_cancelled());
    assert_eq!(wakes.load(Ordering::SeqCst), 4);
    for _ in 0..4 {
        assert_eq!(
            (rx.try_recv().unwrap().access.check)(),
            Err(Error::Cancelled)
        );
    }
    // Cleanup must also wake a native loop when there is room in the queue.
    drop(WaitCleanup {
        client: &client,
        signal,
        access: access(),
    });
    assert!(matches!(
        rx.try_recv().unwrap().operation,
        Operation::Cleanup
    ));
    drop(client);
    assert_eq!(wakes.load(Ordering::SeqCst), 6);
    assert!(matches!(
        rx.try_recv(),
        Err(mpsc::TryRecvError::Disconnected)
    ));
}

#[cfg(windows)]
#[test]
fn windows_discovery_and_mcp_share_one_descriptor() {
    assert_eq!(
        json!(capabilities()),
        Client::default()
            .call(Request::Capabilities, access())
            .unwrap()
    );
}
