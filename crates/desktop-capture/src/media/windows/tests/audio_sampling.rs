use super::*;
use libwebrtc::audio_frame::AudioFrame;
use std::borrow::Cow;

#[test]
#[ignore = "Runs native WebRTC peer connections with synthetic audio; no microphone or system capture"]
fn supported_audio_sampling_formats_reach_the_remote_peer() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        for rate in crate::media::AUDIO_SAMPLE_RATES {
            for channels in crate::media::AUDIO_CHANNEL_COUNTS {
                let media = MediaSession::with_audio_factory(
                    MediaOptions {
                        encoder: "software".into(),
                        audio: true,
                        audio_codec: Some("audio/opus".into()),
                        audio_sample_rate: rate,
                        audio_channel_count: channels,
                        ..Default::default()
                    },
                    |rate, channels, _, _| audio::Loopback::synthetic(rate, channels),
                )
                .unwrap();
                let remote = connect(&media, "sampling", false).await.unwrap();
                let capture = media.audio.as_ref().unwrap();
                let mut received = false;
                let mut cadence = tokio::time::interval(Duration::from_millis(10));
                cadence.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                for n in 0..300 {
                    cadence.tick().await;
                    let samples: Vec<_> = (0..rate / 100)
                        .flat_map(|i| {
                            let phase = (n * rate / 100 + i) as f64 * 440.0 * std::f64::consts::TAU
                                / rate as f64;
                            std::iter::repeat_n((phase.sin() * 10000.0) as i16, channels as usize)
                        })
                        .collect();
                    audio::deliver(
                        &capture.source,
                        &capture.recording,
                        &AudioFrame {
                            data: Cow::Borrowed(&samples),
                            sample_rate: rate,
                            num_channels: channels,
                            samples_per_channel: rate / 100,
                        },
                        crate::media::webrtc::clock_us(),
                    )
                    .unwrap();
                    if n % 20 == 19 {
                        received = remote.pc.get_stats().await.unwrap().iter().any(|stat| {
                            matches!(stat, RtcStats::InboundRtp(s)
                                if s.inbound.total_samples_received > 4800
                                    && s.inbound.total_audio_energy > 0.0)
                        });
                        if received {
                            break;
                        }
                    }
                }
                media.close();
                assert!(
                    received,
                    "No decoded audio at {rate} Hz / {channels} channels"
                );
                eprintln!("Decoded audio at {rate} Hz / {channels} channels");
            }
        }
    });
}
