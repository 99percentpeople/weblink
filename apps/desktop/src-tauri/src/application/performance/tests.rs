use super::*;
use serde_json::{json, Value};
use std::cell::Cell;
use weblink_desktop_capture::performance::Session;

// These tests inject startup results and never write NVIDIA driver profiles.
fn policy(status: power::Status) -> power::Report {
    power::Report {
        backend: Some("NVIDIA DRS"),
        status,
    }
}

fn report(service: &PerformanceService, session: &Session) -> Value {
    serde_json::to_value(service.report(PipelineStats {
        performance: Some(session.snapshot()),
        ..Default::default()
    }))
    .unwrap()
}

#[test]
fn startup_policy_is_retained_across_independent_stream_lifetimes_without_reconfiguration() {
    for status in [
        power::Status::Applied,
        power::Status::AlreadyApplied,
        power::Status::Unsupported,
        power::Status::Failed("driver rejected preference".into()),
    ] {
        let calls = Cell::new(0);
        let expected = serde_json::to_value(&status).unwrap();
        let service = PerformanceService::initialize(|| {
            calls.set(calls.get() + 1);
            policy(status)
        });
        let first = service.streams.session();
        let second = service.streams.session();
        let startup = report(&service, &first);
        assert_eq!(startup["performance"]["timing"]["state"], "inactive");
        assert_eq!(startup["performance"]["powerPolicy"]["status"], expected);
        assert_eq!(
            startup["performance"]["powerPolicy"]["lifetime"],
            "persistentApplication"
        );
        let a = first.acquire().unwrap();
        let b = first.acquire().unwrap();
        let c = second.acquire().unwrap();
        assert_eq!(
            report(&service, &first)["performance"]["remoteConsumers"],
            2
        );
        drop(a);
        first.close();
        drop(b);
        assert_eq!(
            report(&service, &first)["performance"]["timing"]["state"],
            "inactive"
        );
        let active = report(&service, &second);
        assert_eq!(active["performance"]["remoteConsumers"], 1);
        assert_ne!(active["performance"]["timing"]["state"], "inactive");
        drop(c);
        assert_eq!(
            report(&service, &second)["performance"]["powerPolicy"],
            startup["performance"]["powerPolicy"]
        );
        assert_eq!(
            report(&service, &second)["performance"]["timing"]["state"],
            "inactive"
        );
        drop(second.acquire().unwrap());
        drop(service);
        assert_eq!(
            calls.get(),
            1,
            "reporting/reconnect/teardown must not configure power again"
        );
    }
}

#[test]
fn pipeline_wire_contract_is_extended_without_duplicate_keys_or_invented_stream_status() {
    let service = PerformanceService::initialize(|| policy(power::Status::Applied));
    for performance in [None, Some(service.streams.session().snapshot())] {
        let pipeline = PipelineStats {
            frames: 17,
            performance,
            ..Default::default()
        };
        let native = serde_json::to_value(&pipeline).unwrap();
        let raw = serde_json::to_string(&service.report(pipeline)).unwrap();
        let mut combined: Value = serde_json::from_str(&raw).unwrap();
        if let Some(performance) = combined.get_mut("performance") {
            assert_eq!(raw.matches("\"performance\":").count(), 1);
            let power = performance
                .as_object_mut()
                .unwrap()
                .remove("powerPolicy")
                .unwrap();
            assert_eq!(
                power,
                json!({
                    "backend": "NVIDIA DRS",
                    "lifetime": "persistentApplication",
                    "status": { "state": "applied" },
                })
            );
        }
        assert_eq!(combined, native);
    }
}

#[cfg(windows)]
#[test]
fn power_failure_does_not_block_real_media_or_change_preview_and_peer_cleanup() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let calls = Cell::new(0);
        let service = PerformanceService::initialize(|| {
            calls.set(calls.get() + 1);
            policy(power::Status::Failed("power API unavailable".into()))
        });
        let create = || {
            service
                .create_media(MediaOptions {
                    encoder: "software".into(),
                    codec: Some("video/vp8".into()),
                    ..Default::default()
                })
                .unwrap()
        };
        let first = create();
        let second = create();
        let snapshot =
            |media: &MediaSession| serde_json::to_value(service.pipeline_stats(media)).unwrap();
        first
            .offer_trickle("preview".into(), vec![], false, true, Box::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(
            snapshot(&first)["performance"]["timing"]["state"],
            "inactive"
        );
        first
            .offer_trickle("remote-a".into(), vec![], false, false, Box::new(|_| {}))
            .await
            .unwrap();
        second
            .offer_trickle("remote-b".into(), vec![], false, false, Box::new(|_| {}))
            .await
            .unwrap();
        assert_eq!(snapshot(&first)["performance"]["remoteConsumers"], 1);
        assert_eq!(
            snapshot(&first)["performance"]["powerPolicy"]["status"]["state"],
            "failed"
        );
        first.close_peer("remote-a");
        first.close();
        assert_eq!(
            snapshot(&first)["performance"]["timing"]["state"],
            "inactive"
        );
        assert_eq!(snapshot(&second)["performance"]["remoteConsumers"], 1);
        assert_eq!(
            snapshot(&second)["performance"]["timing"]["state"],
            "applied"
        );
        second.close();
        assert_eq!(
            snapshot(&second)["performance"]["timing"]["state"],
            "inactive"
        );
        assert_eq!(
            snapshot(&second)["performance"]["powerPolicy"]["status"]["state"],
            "failed"
        );
        assert_eq!(calls.get(), 1);
    });
}
