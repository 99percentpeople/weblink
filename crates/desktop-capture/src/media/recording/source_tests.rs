use super::super::{fixtures::*, EncodedAudioCodec};
use super::*;
use std::sync::atomic::Ordering;

#[test]
fn every_supported_audio_codec_reuses_payloads_on_the_backend_clock() {
    for codec in [
        EncodedAudioCodec::Opus,
        EncodedAudioCodec::G722,
        EncodedAudioCodec::Pcmu,
        EncodedAudioCodec::Pcma,
    ] {
        let f = Fixture::new(codec);
        let source = RecordingSource::new(f.inputs(true), true).unwrap();
        assert!(source.info.encoded_audio);
        assert!(source.info.audio.is_none());
        source.control(true, 1).unwrap();
        f.video.publish(1_000_000, true, 5);
        f.encoded.publish(Some(1_020_000));
        let batch = packets(&source.read());
        assert_eq!(batch.len(), 2);
        assert_eq!((batch[0].kind, batch[0].clock), (0, 1_000_000));
        assert_eq!(
            (batch[1].kind, batch[1].codec, batch[1].clock),
            (3, codec as u8, 1_020_000)
        );
        assert_eq!(batch[1].payload, [1, 2, 3]);
        assert!(!f.pcm.has_subscriber());
        source.close();
        assert!(!f.encoded.active.load(Ordering::SeqCst));
        assert!(f.video.is_connected());
    }
}

#[test]
fn audio_unavailable_or_explicit_pcm_preference_keeps_the_selected_audio() {
    for (prefer_encoded, supported, observer) in [
        (false, true, true),
        (true, false, true),
        (true, true, false),
    ] {
        let f = Fixture::new(EncodedAudioCodec::G722);
        f.encoded.supported.store(supported, Ordering::SeqCst);
        let mut inputs = f.inputs(true);
        if !observer {
            inputs.audio.as_mut().unwrap().encoded = None;
        }
        let source = RecordingSource::new(inputs, prefer_encoded).unwrap();
        assert!(!source.info.encoded_audio);
        let format = source.info.audio.as_ref().unwrap();
        assert_eq!((format.sample_rate, format.channel_count), (48000, 2));
        source.control(true, 1).unwrap();
        f.video.publish(100, true, 1);
        f.pcm_packet(120);
        let batch = packets(&source.read());
        assert_eq!((batch[1].kind, batch[1].clock), (1, 120));
        assert_eq!(batch[1].payload, [1, 2, 3, 4]);
        assert!(!f.encoded.active.load(Ordering::SeqCst));
        if !prefer_encoded {
            assert_eq!(f.encoded.probes.load(Ordering::SeqCst), 0);
        }
    }
}

#[test]
fn pause_resume_and_repeated_controls_preserve_segments_without_stopping_sources() {
    let f = Fixture::new(EncodedAudioCodec::Opus);
    let source = RecordingSource::new(f.inputs(true), true).unwrap();
    source.control(true, 1).unwrap();
    f.video.publish(10, true, 1);
    f.encoded.publish(Some(11));
    source.control(true, 1).unwrap();
    assert_eq!(
        packets(&source.read()).len(),
        2,
        "Repeated resume must not clear accepted packets"
    );
    source.control(false, 1).unwrap();
    for stamp in 20..120 {
        f.video.publish(stamp, true, 1);
        f.encoded.publish(Some(stamp));
    }
    assert!(source.read().is_empty());
    source.control(true, 2).unwrap();
    f.video.publish(130, false, 1);
    f.video.publish(140, true, 1);
    f.encoded.publish(Some(145));
    assert!(source.control(false, 1).is_err());
    let batch = packets(&source.read());
    assert_eq!(batch.len(), 2);
    assert!(batch.iter().all(|packet| packet.segment == 2));
    assert_eq!(batch[0].clock, 140);
    assert_eq!(f.video.keyframes.load(Ordering::SeqCst), 2);
    assert_eq!(f.video.forwarded.load(Ordering::SeqCst), 103);
    assert_eq!(f.encoded.forwarded.load(Ordering::SeqCst), 102);
}

#[test]
fn sender_disconnect_drains_final_video_and_audio_across_bounded_batches() {
    for encoded in [true, false] {
        let f = Fixture::new(EncodedAudioCodec::Pcma);
        let source = RecordingSource::new(f.inputs(true), encoded).unwrap();
        source.control(true, 3).unwrap();
        for stamp in 0..12 {
            f.video.publish(stamp, true, 128 * 1024);
            if encoded {
                f.encoded.publish(Some(stamp));
            } else {
                f.pcm_packet(stamp);
            }
        }
        f.video.connected.store(false, Ordering::SeqCst);
        let mut batch = packets(&source.read());
        assert!(
            !batch.iter().any(|p| p.kind == 2),
            "End must wait for the remaining video batch"
        );
        batch.extend(packets(&source.read()));
        assert_eq!(batch.iter().filter(|p| p.kind == 0).count(), 12);
        assert_eq!(
            batch
                .iter()
                .filter(|p| p.kind == if encoded { 3 } else { 1 })
                .count(),
            12
        );
        let end = batch.last().unwrap();
        assert_eq!(end.kind, 2);
        assert!(end.payload.is_empty());
        assert!(!f.encoded.active.load(Ordering::SeqCst));
        assert_eq!(packets(&source.read())[0].kind, 2);
    }
}

#[test]
fn audio_end_and_clock_failure_terminate_only_the_recording() {
    for clock_failure in [false, true] {
        let f = Fixture::new(EncodedAudioCodec::Pcmu);
        let source = RecordingSource::new(f.inputs(true), true).unwrap();
        source.control(true, 1).unwrap();
        f.video.publish(10, true, 1);
        f.encoded.publish(Some(11));
        if clock_failure {
            f.encoded.publish(None);
        } else {
            f.encoded.tap.end();
        }
        let mut result = packets(&source.read());
        result.extend(packets(&source.read()));
        let terminal = result.iter().find(|p| p.kind == 2).unwrap();
        assert_eq!(!terminal.payload.is_empty(), clock_failure);
        assert!(result.iter().any(|p| p.kind == 3 && p.payload == [1, 2, 3]));
        assert!(f.video.is_connected());
        assert!(!f.encoded.active.load(Ordering::SeqCst));
    }
}

#[test]
fn slow_consumer_errors_stay_in_the_recording_and_sources_can_be_reused() {
    let f = Fixture::new(EncodedAudioCodec::Opus);
    let source = RecordingSource::new(f.inputs(true), true).unwrap();
    source.control(true, 1).unwrap();
    for stamp in 0..64 {
        f.video.publish(stamp, true, 1);
    }
    let batch = packets(&source.read());
    assert_eq!(batch.len(), 32);
    assert!(batch.iter().all(|packet| packet.kind == 0));
    let terminal = packets(&source.read());
    assert_eq!(terminal.len(), 1);
    assert_eq!(terminal[0].kind, 2);
    let error = String::from_utf8(terminal[0].payload.clone()).unwrap();
    assert!(error.contains("cannot keep up"));
    assert_eq!(f.video.forwarded.load(Ordering::SeqCst), 64);
    assert!(f.video.is_connected());
    source.close();
    let next = RecordingSource::new(f.inputs(true), true).unwrap();
    next.control(true, 1).unwrap();
    f.video.publish(100, true, 1);
    f.encoded.publish(Some(101));
    assert_eq!(packets(&next.read()).len(), 2);
}

#[test]
fn failed_video_subscription_releases_the_borrowed_audio_observer() {
    let f = Fixture::new(EncodedAudioCodec::Opus);
    f.video.tap.end();
    assert!(RecordingSource::new(f.inputs(true), true).is_err());
    assert!(!f.encoded.active.load(Ordering::SeqCst));
    let next = f
        .encoded
        .tap
        .subscribe()
        .expect("Failed preparation must release audio ownership");
    f.encoded.tap.unsubscribe(&next);
}
