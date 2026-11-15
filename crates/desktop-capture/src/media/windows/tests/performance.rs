use super::*;
use crate::performance::{Manager, Status};

#[test]
fn performance_follows_remote_publications_without_affecting_preview_or_other_captures() {
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let manager = Arc::new(Manager::default());
        let create = || {
            MediaSession::with_performance(
                MediaOptions {
                    encoder: "software".into(),
                    codec: Some("video/vp8".into()),
                    ..Default::default()
                },
                manager.clone(),
            )
            .unwrap()
        };
        let first = create();
        let second = create();
        let offer = |media: Arc<MediaSession>, id: &'static str, preview| async move {
            media
                .offer_trickle(id.into(), vec![], false, preview, Box::new(|_| {}))
                .await
        };
        offer(first.clone(), "preview", true).await.unwrap();
        assert_eq!(
            first.pipeline_stats().performance.unwrap().timing,
            Status::Inactive
        );
        offer(first.clone(), "remote-a", false).await.unwrap();
        offer(first.clone(), "remote-b", false).await.unwrap();
        offer(second.clone(), "remote-c", false).await.unwrap();
        assert_eq!(first.performance.snapshot().remote_consumers, 2);
        // A rejected duplicate must neither acquire a lease nor close the live peer.
        assert!(offer(first.clone(), "remote-a", false).await.is_err());
        assert_eq!(first.performance.snapshot().remote_consumers, 2);
        first.close_peer("remote-a");
        assert_eq!(first.performance.snapshot().remote_consumers, 1);
        first.close_peer("remote-b");
        first.close_peer("remote-b");
        assert_eq!(first.performance.snapshot().timing, Status::Inactive);
        assert!(first.peers.lock().unwrap().contains_key("preview"));
        assert_eq!(second.performance.snapshot().remote_consumers, 1);
        assert_eq!(second.performance.snapshot().timing, Status::Applied);
        // Starting again after the last remote leaves must reactivate the scope.
        offer(first.clone(), "remote-d", false).await.unwrap();
        assert_eq!(first.performance.snapshot().remote_consumers, 1);
        first.close();
        assert_eq!(first.performance.snapshot().timing, Status::Inactive);
        assert_eq!(second.performance.snapshot().remote_consumers, 1);
        second.close();
        assert_eq!(second.performance.snapshot().timing, Status::Inactive);
    });
}
