use super::super::{fixtures::*, EncodedAudioCodec, RecordingSessions, VideoSource};
use std::sync::atomic::Ordering;

#[test]
fn duplicates_and_unknown_ids_never_change_an_active_recording() {
    let f = Fixture::new(EncodedAudioCodec::Opus);
    let sessions = RecordingSessions::default();
    sessions
        .open("first".into(), true, || Ok(Some(f.inputs(true))))
        .unwrap()
        .unwrap();
    for id in ["first", "other"] {
        assert!(sessions
            .open(id.into(), true, || panic!(
                "Duplicate must not select a sender"
            ))
            .is_err());
    }
    sessions.close("other");
    assert!(sessions.control("other", true, 1).is_err());
    sessions.control("first", true, 1).unwrap();
    f.video.publish(0, true, 1);
    f.encoded.publish(Some(1));
    assert_eq!(packets(&sessions.read("first").unwrap()).len(), 2);
    sessions.close("first");
    sessions.close("first");
    assert!(sessions.read("first").is_err());
}

#[test]
fn late_read_control_and_drop_do_not_disable_a_new_recording() {
    let f = Fixture::new(EncodedAudioCodec::G722);
    let sessions = RecordingSessions::default();
    sessions
        .open("old".into(), true, || Ok(Some(f.inputs(true))))
        .unwrap();
    sessions.control("old", true, 1).unwrap();
    // Represents a read that retained the source before close removed its ID.
    let retained = sessions.source("old").unwrap();
    sessions.close("old");
    assert!(!f.encoded.active.load(Ordering::SeqCst));
    sessions
        .open("new".into(), true, || Ok(Some(f.inputs(true))))
        .unwrap();
    sessions.control("new", true, 1).unwrap();
    assert_eq!(packets(&retained.read())[0].kind, 2);
    retained.control(false, 3).unwrap();
    drop(retained);
    sessions.close("old");
    assert!(f.encoded.active.load(Ordering::SeqCst));
    f.video.publish(30, true, 1);
    f.encoded.publish(Some(31));
    assert_eq!(packets(&sessions.read("new").unwrap()).len(), 2);
}

#[test]
fn unsupported_sources_and_probe_failure_can_retry_pcm_then_shutdown_permanently() {
    let f = Fixture::new(EncodedAudioCodec::Pcma);
    let sessions = RecordingSessions::default();
    assert!(sessions
        .open("none".into(), true, || Ok(None))
        .unwrap()
        .is_none());
    assert!(sessions
        .open("error".into(), true, || Err("backend unavailable".into()))
        .is_err());
    sessions
        .open("encoded".into(), true, || Ok(Some(f.inputs(true))))
        .unwrap();
    sessions.control("encoded", true, 1).unwrap();
    f.encoded.publish(None);
    sessions.close("encoded");
    let info = sessions
        .open("pcm".into(), false, || Ok(Some(f.inputs(true))))
        .unwrap()
        .unwrap();
    assert!(!info.encoded_audio);
    assert!(info.audio.is_some());
    sessions.control("pcm", true, 1).unwrap();
    f.video.publish(10, true, 1);
    f.pcm_packet(11);
    assert_eq!(packets(&sessions.read("pcm").unwrap())[1].kind, 1);
    sessions.shutdown();
    sessions.shutdown();
    assert!(!f.video.tap.has_subscriber());
    assert!(!f.pcm.has_subscriber());
    assert!(f.video.is_connected());
    assert!(sessions
        .open("after".into(), true, || panic!(
            "Closed manager must not touch the sender"
        ))
        .unwrap()
        .is_none());
}

#[test]
fn dropping_sessions_releases_recording_only_including_retained_readers() {
    let f = Fixture::new(EncodedAudioCodec::Opus);
    let retained = {
        let sessions = RecordingSessions::default();
        sessions
            .open("id".into(), true, || Ok(Some(f.inputs(false))))
            .unwrap();
        sessions.control("id", true, 1).unwrap();
        sessions.source("id").unwrap()
    };
    assert_eq!(packets(&retained.read())[0].kind, 2);
    let observer = f.video.tap.subscribe().unwrap();
    f.video.publish(10, true, 1);
    assert_eq!(
        observer
            .receive(std::time::Duration::ZERO)
            .unwrap()
            .timestamp_us,
        10
    );
    f.video.tap.unsubscribe(&observer);
}
