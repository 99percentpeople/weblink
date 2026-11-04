use super::*;
use crate::room_peer::bandwidth::RoomBandwidth;
use libwebrtc::rtp_transceiver::RtpTransceiver;

impl MediaSession {
    #[cfg(test)]
    pub(crate) fn applied_room_vfr(&self, id: &str) -> Option<u32> {
        self.peers
            .lock()
            .unwrap()
            .get(id)?
            .software_sender
            .as_ref()?
            .applied_frame_rate()
    }
    pub(super) fn configure_screen_codecs(
        factory: &PeerConnectionFactory,
        transceiver: &RtpTransceiver,
        options: &MediaOptions,
        pre_encoded: bool,
    ) -> Result<()> {
        let codecs: Vec<_> = factory
            .get_rtp_sender_capabilities(MediaType::Video)
            .codecs
            .into_iter()
            .filter(|c| {
                (options
                    .codec
                    .as_ref()
                    .is_none_or(|codec| c.mime_type.eq_ignore_ascii_case(codec))
                    && (options.vp8_color_compatible()
                        || !c.mime_type.eq_ignore_ascii_case("video/vp8"))
                    && (!pre_encoded
                        || options.codec.as_deref() != Some("video/h264")
                        || c.sdp_fmtp_line
                            .as_deref()
                            .is_some_and(|line| line.contains("profile-level-id=42"))))
                    || matches!(
                        c.mime_type.to_lowercase().as_str(),
                        "video/rtx" | "video/red" | "video/ulpfec"
                    )
            })
            .collect();
        transceiver
            .set_codec_preferences(codecs)
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Attach this capture's existing encoder/PCM sources to a member's transport.
    /// A capture lease owns just its transceivers, never the room PC or its observers.
    pub(crate) fn attach_room(
        &self,
        id: &str,
        factory: &PeerConnectionFactory,
        pc: &PeerConnection,
        bandwidth: &Arc<RoomBandwidth>,
        codecs: &super::super::SendCodecs,
        port: Option<Arc<dyn super::super::control::Port>>,
    ) -> Result<()> {
        if id.is_empty() || id.len() > 128 {
            return Err("Invalid room screen ID".into());
        }
        let current = self.options.lock().unwrap_or_else(|e| e.into_inner());
        let options = codecs.apply(&current)?;
        let hw = if options.encoder == "software" {
            None
        } else {
            select_hardware_encoder(&options, self.encoders.clone())?
        };
        if hw.is_none() && !Self::software_codecs().contains(&codecs.video) {
            return Err("No screen encoder for selected format".into());
        }
        let mut peers = self.peers.lock().unwrap_or_else(|e| e.into_inner());
        if self.closed.load(Ordering::Acquire) || peers.contains_key(id) || peers.len() >= 32 {
            return Err("Screen capture closed or busy".into());
        }
        let consumer = hw
            .map(|h| {
                self.hardware.acquire(
                    id.to_owned(),
                    h.id,
                    options.clone(),
                    false,
                    false,
                    self.encoding_wake(),
                )
            })
            .transpose()?;
        let source = consumer
            .as_ref()
            .and_then(|c| c.output.as_ref())
            .map(|o| &o.source)
            .unwrap_or(&self.source);
        let mut tracks = Vec::new();
        let result = (|| {
            let stream = format!("weblink-screen-{id}");
            let video = factory.create_video_track(&format!("screen-{id}"), source.clone());
            let t = pc
                .add_transceiver(
                    MediaStreamTrack::Video(video),
                    RtpTransceiverInit {
                        direction: RtpTransceiverDirection::SendOnly,
                        stream_ids: vec![stream.clone()],
                        send_encodings: vec![RtpEncodingParameters {
                            max_bitrate: Some(options.max_bitrate),
                            max_framerate: Some(options.frame_rate as f64),
                            ..Default::default()
                        }],
                    },
                )
                .map_err(|e| e.to_string())?;
            tracks.push(t.clone());
            Self::configure_screen_codecs(factory, &t, &options, consumer.is_some())?;
            let sender = t.sender();
            let software_sender = if consumer.is_some() {
                sender.set_video_encoder_backend(VideoEncoderBackend::PreEncoded);
                None
            } else {
                Some(
                    factory
                        .configure_software_sender(
                            &sender,
                            super::super::webrtc::software_preset(options.encoding_preset),
                            options.frame_rate,
                        )
                        .map_err(|error| error.to_string())?,
                )
            };
            // Match the dedicated screen path from the first frame. The
            // upstream encoder already adapts pre-encoded screen video.
            update_sender_parameters(&sender, |parameters| {
                parameters.set_degradation_preference(Self::degradation_preference(
                    &options,
                    false,
                    consumer.is_some(),
                ));
            })?;
            let mut recording_audio = None;
            if let Some(audio) = &self.audio {
                let audio_track =
                    factory.create_audio_track(&format!("screen-audio-{id}"), audio.source.clone());
                let t = pc
                    .add_transceiver(
                        MediaStreamTrack::Audio(audio_track),
                        RtpTransceiverInit {
                            direction: RtpTransceiverDirection::SendOnly,
                            stream_ids: vec![stream],
                            send_encodings: vec![Default::default()],
                        },
                    )
                    .map_err(|e| e.to_string())?;
                tracks.push(t.clone());
                if let Some(codec) = &options.audio_codec {
                    let mut codecs = factory.get_rtp_sender_capabilities(MediaType::Audio).codecs;
                    codecs.sort_by_key(|c| !c.mime_type.eq_ignore_ascii_case(codec));
                    t.set_codec_preferences(codecs).map_err(|e| e.to_string())?;
                }
                if consumer.is_some() {
                    recording_audio = SenderAudioRecording::new(t.sender());
                }
            }
            let budget = bandwidth.screen(t, options.max_bitrate, self.audio.is_some())?;
            let control = port
                .map(|p| control::Channels::connect_named(pc, p, Some(id)))
                .transpose()?;
            Ok::<_, String>((recording_audio, control, software_sender, budget))
        })();
        let (recording_audio, control, software_sender, budget) = match result {
            Ok(ok) => ok,
            Err(error) => {
                for t in tracks {
                    let _ = t.stop();
                }
                drop(peers);
                drop(current);
                self.hardware.release_peer(id);
                return Err(error);
            }
        };
        peers.insert(
            id.to_owned(),
            MediaPeer {
                _factory: factory.clone(),
                encoding: options,
                limits: None,
                connection: pc.clone(),
                gathering: None,
                room_tracks: tracks,
                room_budget: Some(budget),
                software_sender,
                preview: false,
                raw_video: consumer.is_none(),
                control,
                recording: None,
                recording_audio,
                encoded: consumer,
            },
        );
        drop(peers);
        drop(current);
        self.wake_capture();
        Ok(())
    }
    pub(crate) fn room_keyframe(&self, id: &str) {
        if let Some(encoder) = self.hardware.encoder(id) {
            encoder.request_recording_keyframe();
        }
    }
}
