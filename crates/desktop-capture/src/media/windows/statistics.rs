use super::MediaSession;
use crate::media::VideoStats;
use libwebrtc::stats::RtcStats;

impl MediaSession {
    pub async fn stats(&self, id: &str) -> crate::Result<Vec<VideoStats>> {
        let pc = self
            .peers
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|peer| peer.connection.clone())
            .ok_or("Media peer is no longer active")?;
        let report = pc.get_stats().await.map_err(|e| e.to_string())?;
        let hardware = self
            .hardware
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .map(|encoder| encoder.statistics());
        let timestamp = self.started.elapsed().as_secs_f64() * 1000.0;
        Ok(report
            .iter()
            .filter_map(|stat| {
                let RtcStats::OutboundRtp(s) = stat else {
                    return None;
                };
                if s.stream.kind != "video" {
                    return None;
                }
                let codec = report
                    .iter()
                    .find_map(|stat| match stat {
                        RtcStats::Codec(c) if c.rtc.id == s.stream.codec_id => {
                            Some(c.codec.mime_type.clone())
                        }
                        _ => None,
                    })
                    .unwrap_or_default();
                let (encode_frames, encode_seconds, implementation) =
                    if let Some(metrics) = &hardware {
                        (metrics.frames, metrics.seconds, "Media Foundation".into())
                    } else {
                        (
                            s.outbound.frames_encoded as u64,
                            s.outbound.total_encode_time,
                            s.outbound.encoder_implementation.clone(),
                        )
                    };
                let pair_id = report.iter().find_map(|stat| match stat {
                    RtcStats::Transport(t) if t.rtc.id == s.stream.transport_id => {
                        Some(&t.transport.selected_candidate_pair_id)
                    }
                    _ => None,
                });
                let pair = report.iter().find_map(|stat| match stat {
                    RtcStats::CandidatePair(pair) if Some(&pair.rtc.id) == pair_id => {
                        Some(&pair.candidate_pair)
                    }
                    _ => None,
                });
                Some(VideoStats {
                    id: s.rtc.id.clone(),
                    timestamp,
                    codec,
                    implementation,
                    color_space: self
                        .options
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .color_space(),
                    bit_depth: 8,
                    chroma_subsampling: "4:2:0",
                    width: s.outbound.frame_width,
                    height: s.outbound.frame_height,
                    bytes: s.sent.bytes_sent,
                    // The binding defaults absent numeric stats to zero.
                    target_bitrate: positive_bitrate(s.outbound.target_bitrate),
                    encoder_bitrate: hardware.as_ref().and_then(|s| s.bitrate),
                    available_outgoing_bitrate: pair
                        .and_then(|p| positive_bitrate(p.available_outgoing_bitrate)),
                    frames: s.outbound.frames_encoded,
                    encode_frames,
                    encode_seconds,
                    capture_frames: self
                        .latest_sequence
                        .load(std::sync::atomic::Ordering::Relaxed),
                    replaced_inputs: hardware.as_ref().map(|s| s.replaced_inputs),
                    rate_limited_inputs: hardware.as_ref().map(|s| s.rate_limited_inputs),
                    encoder_queue_seconds: hardware.as_ref().map(|s| s.queue.seconds),
                    capture_to_encode_seconds: hardware
                        .as_ref()
                        .map(|s| s.capture_to_encode.seconds),
                    fresh_frames: hardware.as_ref().map(|s| s.capture_to_encode.count),
                    packets_sent: s.sent.packets_sent,
                    send_delay_seconds: s.outbound.total_packet_send_delay,
                    round_trip_seconds: pair
                        .filter(|p| p.responses_received > 0)
                        .map(|p| p.current_round_trip_time),
                })
            })
            .collect())
    }
}

fn positive_bitrate(value: f64) -> Option<f64> {
    (value.is_finite() && value > 0.0).then_some(value)
}
