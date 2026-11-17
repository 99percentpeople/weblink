//! Negotiate libwebrtc's optional capture clock for native screen audio and video.
const URI: &str = "http://www.webrtc.org/experiments/rtp-hdrext/abs-capture-time";

#[cfg(windows)]
pub(crate) async fn set_local_offer(
    pc: &libwebrtc::peer_connection::PeerConnection,
    mut offer: libwebrtc::session_description::SessionDescription,
    enable: bool,
) -> crate::Result<String> {
    use libwebrtc::session_description::{SdpType, SessionDescription};

    // A browser receiving one-way video needs RRTR/DLRR to map the sender's
    // capture clock. Advertise it even when the optional RTP extension is off.
    offer.enable_receiver_reference_time_report();
    let sdp = offer.to_string();
    // The Rust transceiver API cannot configure header extensions. Publish the
    // extended SDP only if the native stack installed it on this connection.
    let candidate = if enable {
        with_capture_time(&sdp).and_then(|s| SessionDescription::parse(&s, SdpType::Offer).ok())
    } else {
        None
    };
    if let Some(candidate) = candidate {
        let extended = candidate.to_string();
        if pc.set_local_description(candidate).await.is_ok() {
            return Ok(extended);
        }
    }
    pc.set_local_description(offer)
        .await
        .map_err(|e| e.to_string())?;
    Ok(sdp)
}

fn with_capture_time(sdp: &str) -> Option<String> {
    let lines: Vec<_> = sdp.lines().collect();
    let first_media = lines.iter().position(|line| line.starts_with("m="))?;
    // The native SDK generates media-level extmaps. Preserve session-level
    // negotiation and any SDK that already advertises the clock itself.
    if lines[..first_media]
        .iter()
        .any(|l| l.starts_with("a=extmap:"))
    {
        return None;
    }
    let mut used = [false; 15];
    for ext in lines.iter().filter_map(|l| l.strip_prefix("a=extmap:")) {
        let mut fields = ext.split_ascii_whitespace();
        let id: usize = fields.next()?.split('/').next()?.parse().ok()?;
        if fields.any(|field| field == URI) {
            return None;
        }
        if let Some(slot) = used.get_mut(id) {
            *slot = true;
        }
    }
    // A single free one-byte ID across all bundled media avoids collisions.
    let id = (1..used.len()).find(|&id| !used[id])?;
    let mut output = Vec::new();
    let extmap = format!("a=extmap:{id} {URI}");
    output.extend_from_slice(&lines[..first_media]);
    let mut added = false;
    for section in lines[first_media..].chunk_by(|_, next| !next.starts_with("m=")) {
        output.extend_from_slice(section);
        let mut fields = section[0].split_ascii_whitespace();
        if matches!(fields.next(), Some("m=audio" | "m=video"))
            && fields.next()?.split('/').next()? != "0"
            && !section
                .iter()
                .any(|l| matches!(*l, "a=recvonly" | "a=inactive"))
        {
            output.push(&extmap);
            added = true;
        }
    }
    added.then(|| output.join("\r\n") + "\r\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    #[test]
    fn video_only_offers_negotiate_capture_clock_feedback() {
        use libwebrtc::{
            peer_connection::OfferOptions,
            peer_connection_factory::{PeerConnectionFactory, RtcConfiguration},
            rtp_transceiver::{RtpTransceiverDirection, RtpTransceiverInit},
            MediaType,
        };
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for extension in [false, true] {
                let factory = PeerConnectionFactory::default();
                let pc = factory
                    .create_peer_connection(RtcConfiguration::default())
                    .unwrap();
                pc.add_transceiver_for_media(
                    MediaType::Video,
                    RtpTransceiverInit {
                        direction: RtpTransceiverDirection::SendOnly,
                        stream_ids: vec![],
                        send_encodings: vec![],
                    },
                )
                .unwrap();
                let offer = pc.create_offer(OfferOptions::default()).await.unwrap();
                let sdp = set_local_offer(&pc, offer, extension).await.unwrap();
                assert!(sdp.contains("a=sendonly"));
                assert!(!sdp.contains("m=audio"));
                assert_eq!(sdp.contains(URI), extension);
                let payload = sdp
                    .lines()
                    .find_map(|line| {
                        line.strip_prefix("a=rtpmap:")
                            .and_then(|mapping| mapping.split_once(" VP8/90000"))
                            .map(|(payload, _)| payload)
                    })
                    .expect("VP8 sender codec");
                assert!(
                    sdp.contains(&format!("a=rtcp-fb:{payload} rrtr\r\n")),
                    "Browser receivers need capture-clock feedback on send-only video: {sdp}"
                );
                pc.close();
            }
        });
    }

    #[test]
    fn shares_a_free_id_only_across_active_sending_media() {
        let sdp = "v=0\r\nm=audio 9 RTP/AVP 111\r\na=extmap:1/sendonly urn:a\r\nm=video 9 RTP/AVP 96\r\na=extmap:2 urn:b\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nm=audio 0 RTP/AVP 111\r\nm=video 9 RTP/AVP 96\r\na=recvonly\r\n";
        let result = with_capture_time(sdp).unwrap();
        let ext = format!("a=extmap:3 {URI}\r\n");
        assert_eq!(result.matches(&ext).count(), 2);
        let (av, rest) = result.split_once("m=application").unwrap();
        assert!(av.split("m=video").all(|section| section.contains(&ext)));
        assert!(!rest.contains(URI));
        assert_eq!(result.replace(&ext, ""), sdp);
        assert!(with_capture_time(&result).is_none());
    }

    #[test]
    fn preserves_existing_negotiation_when_no_compatible_id_is_available() {
        let mut full = String::from("v=0\r\nm=video 9 RTP/AVP 96\r\n");
        for id in 1..=14 {
            full.push_str(&format!("a=extmap:{id} urn:{id}\r\n"));
        }
        assert!(with_capture_time(&full).is_none());
        assert!(
            with_capture_time("v=0\r\na=extmap:1 urn:a\r\nm=audio 9 RTP/AVP 111\r\n").is_none()
        );
        assert!(with_capture_time("v=0\r\nm=video 9 RTP/AVP 96\r\na=inactive\r\n").is_none());
    }
}
