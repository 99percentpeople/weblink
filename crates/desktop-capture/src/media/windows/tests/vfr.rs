//! Exercise the capture worker with real GPU arrivals and local WebRTC receivers.
//! Direct publish_frame calls would bypass VFR scheduling and retained pixels.
use super::*;
use windows::Win32::Graphics::{Direct3D11::*, Dxgi::Common::*};

pub(super) struct Frames {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    textures: Vec<ID3D11Texture2D>,
}
impl Frames {
    pub(super) fn new() -> Self {
        let (device, context) = windows_capture::d3d11::create_d3d_device().unwrap();
        let textures = (0..4)
            .map(|phase| {
                let mut pixels = Vec::with_capacity(640 * 360 * 4);
                for y in 0..360 {
                    for x in 0..640 {
                        // Hard scene changes after idle expose the software
                        // encoder's sparse-input rate-control recovery.
                        let value = ((x / 16 * 37 + y / 16 * 71 + phase * 89) % 192 + 32) as u8;
                        pixels.extend_from_slice(&[value, value, value, 255]);
                    }
                }
                let desc = D3D11_TEXTURE2D_DESC {
                    Width: 640,
                    Height: 360,
                    MipLevels: 1,
                    ArraySize: 1,
                    Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                    SampleDesc: DXGI_SAMPLE_DESC {
                        Count: 1,
                        Quality: 0,
                    },
                    Usage: D3D11_USAGE_DEFAULT,
                    BindFlags: D3D11_BIND_SHADER_RESOURCE.0 as u32,
                    ..Default::default()
                };
                let data = D3D11_SUBRESOURCE_DATA {
                    pSysMem: pixels.as_ptr().cast(),
                    SysMemPitch: 640 * 4,
                    SysMemSlicePitch: 0,
                };
                let mut texture = None;
                unsafe { device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }.unwrap();
                texture.unwrap()
            })
            .collect();
        Self {
            device,
            context,
            textures,
        }
    }
    pub(super) fn send(&self, media: &MediaSession, index: usize) {
        self.send_with_cursor(media, index, None);
    }
    pub(super) fn send_with_cursor(
        &self,
        media: &MediaSession,
        index: usize,
        cursor: Option<&crate::surface::Cursor>,
    ) {
        media
            .frame(TextureFrame {
                dirty_regions: None,
                device: &self.device,
                context: &self.context,
                texture: &self.textures[index % self.textures.len()],
                rotation: Rotation::Identity,
                cursor,
            })
            .unwrap();
    }
}

pub(super) async fn wait_for_video(receiver: &Receiver) {
    let before = decoded(receiver).await;
    tokio::time::timeout(Duration::from_secs(8), async {
        while decoded(receiver).await < before + 2 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .expect("Retained static pixels did not reach the viewer");
}

async fn encoded(media: &MediaSession, id: &str) -> u64 {
    media
        .stats(id)
        .await
        .unwrap()
        .iter()
        .map(|s| s.encode_frames)
        .sum()
}

pub(super) async fn static_frames(media: &MediaSession, id: &str) -> u64 {
    let captures = media.latest_sequence.load(Ordering::Acquire);
    let before = encoded(media, id).await;
    tokio::time::sleep(Duration::from_secs(2)).await;
    let frames = encoded(media, id).await - before;
    assert!(
        frames <= 6,
        "Static content was encoded above VFR refresh rate: {frames}"
    );
    assert_eq!(
        media.latest_sequence.load(Ordering::Acquire),
        captures,
        "Static refresh must reuse converted pixels"
    );
    frames
}

pub(super) async fn motion(
    frames: &Frames,
    media: &MediaSession,
    receiver: &Receiver,
) -> (u32, Duration) {
    let before = decoded(receiver).await;
    let start = Instant::now();
    let mut first = None;
    let mut feed = tokio::time::interval(Duration::from_millis(20));
    feed.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut index = 0;
    while start.elapsed() < Duration::from_secs(2) {
        feed.tick().await;
        frames.send(media, index);
        index += 1;
        if first.is_none() && decoded(receiver).await > before {
            first = Some(start.elapsed());
        }
    }
    tokio::time::sleep(Duration::from_millis(150)).await;
    (
        decoded(receiver).await - before,
        first.expect("Motion never resumed"),
    )
}

fn software_vfr(codec: &str) {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let media = MediaSession::new(MediaOptions {
            encoder: "software".into(),
            codec: Some(codec.into()),
            frame_rate: 20,
            max_width: 640,
            max_height: 360,
            max_bitrate: 1_000_000,
            degradation_preference: "maintain-resolution".into(),
            ..Default::default()
        }).unwrap();
        let receiver = connect(&media, "vfr", false).await.unwrap();
        let frames = Frames::new();
        frames.send(&media, 0);
        // NativeVideoSource emits black keepalive frames before its first real
        // capture. Those must not satisfy the VFR startup or idle measurement.
        tokio::time::timeout(Duration::from_secs(3), async {
            while media.latest_sequence.load(Ordering::Acquire) == 0 {
                assert!(media.error().is_none(), "{:?}", media.error());
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.expect("First GPU arrival was not published");
        wait_for_video(&receiver).await;
        assert_eq!(media.latest_sequence.load(Ordering::Acquire), 1);
        let idle = static_frames(&media, "vfr").await;

        // The source stays static throughout the new viewer's negotiation.
        let late = connect(&media, "late", true).await.unwrap();
        wait_for_video(&late).await;
        assert_eq!(media.latest_sequence.load(Ordering::Acquire), 1);
        media.close_peer("late");
        let (fast, resumed) = motion(&frames, &media, &receiver).await;
        assert!(fast >= 20, "{codec}: motion remained at idle cadence: {fast}");
        assert!(resumed < Duration::from_millis(750), "{codec}: motion resume stalled: {resumed:?}");
        media.update_video_settings(VideoSettings {
            max_width: 640,
            max_height: 360,
            frame_rate: 5,
            max_bitrate: 1_000_000,
            degradation_preference: "maintain-resolution".into(),
        }).unwrap();
        let (slow, _) = motion(&frames, &media, &receiver).await;
        assert!((4..=13).contains(&slow), "{codec}: live FPS cap was lost: {slow}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        let idle_after = static_frames(&media, "vfr").await;
        let stats = media.stats("vfr").await.unwrap();
        assert!(stats.iter().any(|s| s.codec.eq_ignore_ascii_case(codec)));
        assert!(media.hardware.lock().unwrap().is_empty());

        // No capture arrival is needed after all consumers have gone away.
        media.close_peer("vfr");
        let captures = media.latest_sequence.load(Ordering::Acquire);
        let restarted = connect(&media, "restart", false).await.unwrap();
        wait_for_video(&restarted).await;
        assert_eq!(media.latest_sequence.load(Ordering::Acquire), captures);
        eprintln!("{codec} VFR: static={idle}/2s, resumed={resumed:?}, motion={fast}/2s, capped={slow}/2s, static_after={idle_after}/2s");
        media.close();
        assert!(media.latest.lock().unwrap().is_none());
    });
}

#[test]
fn software_h264_uses_vfr_and_recovers_from_idle() {
    software_vfr("video/h264");
}
#[test]
fn software_vp8_uses_vfr_and_recovers_from_idle() {
    software_vfr("video/vp8");
}
#[test]
fn software_vp9_uses_vfr_and_recovers_from_idle() {
    software_vfr("video/vp9");
}
#[test]
fn software_av1_uses_vfr_and_recovers_from_idle() {
    software_vfr("video/av1");
}
