use super::*;
use crate::media::{gathered_sdp, IceCandidate};
use libwebrtc::{
    peer_connection::{AnswerOptions, IceGatheringState, OfferOptions},
    peer_connection_factory::{ContinualGatheringPolicy, PeerConnectionFactory, RtcConfiguration},
    session_description::{SdpType, SessionDescription},
};
use std::{
    sync::{atomic::AtomicUsize, Mutex},
    time::Duration,
};
use tokio::sync::Notify;

#[derive(Default)]
struct TestPort {
    sender: Mutex<Option<Arc<dyn Sender>>>,
    changed: Notify,
    writable: AtomicUsize,
}
impl Port for TestPort {
    fn opened(&self, sender: Arc<dyn Sender>) {
        *self.sender.lock().unwrap() = Some(sender);
        self.changed.notify_one();
    }
    fn writable(&self) {
        self.writable.fetch_add(1, Ordering::AcqRel);
        self.changed.notify_one();
    }
    fn message(&self, _: bool, _: &[u8]) {}
    fn closed(&self) {
        self.changed.notify_one();
    }
}

async fn gather(pc: &PeerConnection, description: SessionDescription) -> String {
    let gathering = Arc::new(super::super::ice::Gathering::new());
    let completed = gathering.clone();
    pc.on_ice_gathering_state_change(Some(Box::new(move |state| {
        if state == IceGatheringState::Complete {
            completed.complete();
        }
    })));
    let candidates = Arc::new(Mutex::new(Vec::new()));
    let received = candidates.clone();
    pc.on_ice_candidate(Some(Box::new(move |candidate| {
        received.lock().unwrap().push(IceCandidate {
            candidate: candidate.to_string(),
            sdp_mid: Some(candidate.sdp_mid()),
            sdp_m_line_index: u16::try_from(candidate.sdp_mline_index()).ok(),
        });
    })));
    let sdp = description.to_string();
    pc.set_local_description(description).await.unwrap();
    tokio::time::timeout(Duration::from_secs(10), gathering.wait())
        .await
        .unwrap()
        .unwrap();
    pc.on_ice_candidate(None);
    pc.on_ice_gathering_state_change(None);
    let sdp = gathered_sdp(&sdp, &candidates.lock().unwrap());
    sdp
}

#[test]
fn native_channels_deliver_a_burst_and_close_without_retry_polling() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let factory = PeerConnectionFactory::default();
        let config = || {
            let mut config = RtcConfiguration::default();
            config.continual_gathering_policy = ContinualGatheringPolicy::GatherOnce;
            config
        };
        let local = factory.create_peer_connection(config()).unwrap();
        let remote = factory.create_peer_connection(config()).unwrap();
        let port = Arc::new(TestPort::default());
        let channels = Channels::connect(&local, port.clone()).unwrap();
        let received = Arc::new(AtomicUsize::new(0));
        let delivered = Arc::new(Notify::new());
        let incoming = Arc::new(Mutex::new(Vec::new()));
        let keep = incoming.clone();
        let count = received.clone();
        let delivery = delivered.clone();
        remote.on_data_channel(Some(Box::new(move |channel| {
            let count = count.clone();
            let delivery = delivery.clone();
            channel.on_message(Some(Box::new(move |_| {
                count.fetch_add(1, Ordering::AcqRel);
                delivery.notify_one();
            })));
            keep.lock().unwrap().push(channel);
        })));
        let offer = local.create_offer(OfferOptions::default()).await.unwrap();
        let offer = gather(&local, offer).await;
        remote
            .set_remote_description(SessionDescription::parse(&offer, SdpType::Offer).unwrap())
            .await
            .unwrap();
        let answer = remote
            .create_answer(AnswerOptions::default())
            .await
            .unwrap();
        let answer = gather(&remote, answer).await;
        local
            .set_remote_description(SessionDescription::parse(&answer, SdpType::Answer).unwrap())
            .await
            .unwrap();
        let sender = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if let Some(sender) = port.sender.lock().unwrap().clone() {
                    break sender;
                }
                port.changed.notified().await;
            }
        })
        .await
        .unwrap();
        let payload = vec![b'x'; MAX_OUTBOUND_BYTES];
        let mut blocked = 0;
        tokio::time::timeout(Duration::from_secs(15), async {
            for _ in 0..256 {
                loop {
                    match sender.send(&payload) {
                        SendResult::Sent => break,
                        SendResult::Backpressure => {
                            blocked += 1;
                            port.changed.notified().await;
                        }
                        SendResult::Closed => panic!("Control closed during a bounded burst"),
                    }
                }
            }
            while received.load(Ordering::Acquire) != 256 {
                delivered.notified().await;
            }
        })
        .await
        .unwrap();
        // A fast loopback may never fill the native buffer. Deterministic
        // backpressure and wake races are covered by the owner transport tests.
        println!("Native burst: 256 messages delivered; {blocked} notification-driven retries");
        // An invalid message with no queued bytes has no future drain event.
        assert_eq!(sender.send(&[0xff]), SendResult::Closed);
        channels.close();
        assert_eq!(sender.send(b"closed"), SendResult::Closed);
        remote.on_data_channel(None);
        for channel in incoming.lock().unwrap().drain(..) {
            channel.on_message(None);
            channel.close();
        }
        local.close();
        remote.close();
    });
}
