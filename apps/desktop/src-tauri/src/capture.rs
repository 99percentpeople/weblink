use std::sync::Arc;
use tauri::State;
use weblink_desktop_capture::{
    CaptureCapabilities, CaptureOptions, CaptureService, CaptureSource, CaptureStatus,
};

pub type Service = Arc<CaptureService>;

#[tauri::command]
pub async fn capture_display_layout(
    service: State<'_, Service>,
) -> Result<weblink_desktop_capture::geometry::DisplayLayout, String> {
    run(service, CaptureService::display_layout).await
}

pub async fn run<T: Send + 'static>(
    service: State<'_, Service>,
    operation: impl FnOnce(&CaptureService) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let service = service.inner().clone();
    tauri::async_runtime::spawn_blocking(move || operation(&service))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn capture_sources(service: State<'_, Service>) -> Result<Vec<CaptureSource>, String> {
    run(service, CaptureService::sources).await
}

#[tauri::command]
pub async fn capture_thumbnail(
    service: State<'_, Service>,
    source_id: String,
    options: Option<CaptureOptions>,
) -> Result<tauri::ipc::Response, String> {
    run(service, move |s| {
        s.thumbnail(source_id, options.unwrap_or_default())
    })
    .await
    .map(tauri::ipc::Response::new)
}

#[tauri::command]
pub async fn capture_start(
    service: State<'_, Service>,
    source_id: String,
    options: Option<CaptureOptions>,
) -> Result<CaptureStatus, String> {
    run(service, move |s| {
        s.start_with_options(source_id, options.unwrap_or_default())
    })
    .await
}

#[tauri::command]
pub async fn capture_status(
    service: State<'_, Service>,
    session_id: String,
) -> Result<CaptureStatus, String> {
    run(service, move |s| s.status(session_id)).await
}

#[tauri::command]
pub async fn capture_stop(
    service: State<'_, Service>,
    session_id: String,
) -> Result<CaptureStatus, String> {
    run(service, move |s| s.stop(session_id)).await
}

#[tauri::command]
pub async fn capture_share_start(
    service: State<'_, Service>,
    source_id: String,
    options: weblink_desktop_capture::media::MediaOptions,
    capture: Option<CaptureOptions>,
) -> Result<CaptureStatus, String> {
    run(service, move |s| {
        let media = weblink_desktop_capture::media::MediaSession::new(options)?;
        s.start_media_with_options(source_id, media, capture.unwrap_or_default())
    })
    .await
}

#[tauri::command]
// Webview and service are injected; preserve the existing IPC argument contract.
#[allow(clippy::too_many_arguments)]
pub async fn capture_offer(
    webview: tauri::Webview,
    service: State<'_, Service>,
    session_id: String,
    peer_id: String,
    ice_servers: Vec<weblink_desktop_capture::media::IceServer>,
    relay_only: bool,
    preview: bool,
    candidates: Option<tauri::ipc::JavaScriptChannelId>,
) -> Result<String, String> {
    let media = run(service, move |s| s.media(session_id)).await?;
    if let Some(channel) = candidates {
        let channel =
            channel.channel_on::<_, weblink_desktop_capture::media::IceCandidate>(webview);
        media
            .offer_trickle(
                peer_id,
                ice_servers,
                relay_only,
                preview,
                Box::new(move |candidate| {
                    let _ = channel.send(candidate);
                }),
            )
            .await
    } else {
        media.offer(peer_id, ice_servers, relay_only, preview).await
    }
}

#[tauri::command]
pub async fn capture_add_ice_candidate(
    service: State<'_, Service>,
    session_id: String,
    peer_id: String,
    candidate: weblink_desktop_capture::media::IceCandidate,
) -> Result<(), String> {
    let media = run(service, move |s| s.media(session_id)).await?;
    media.add_ice_candidate(&peer_id, candidate).await
}

#[tauri::command]
pub async fn capture_answer(
    service: State<'_, Service>,
    session_id: String,
    peer_id: String,
    sdp: String,
) -> Result<(), String> {
    let media = run(service, move |s| s.media(session_id)).await?;
    media.answer(&peer_id, &sdp).await
}

#[tauri::command]
pub async fn capture_video_stats(
    service: State<'_, Service>,
    session_id: String,
    peer_id: String,
) -> Result<Vec<weblink_desktop_capture::media::VideoStats>, String> {
    let media = run(service, move |s| s.media(session_id)).await?;
    media.stats(&peer_id).await
}

#[tauri::command]
pub async fn capture_pipeline_stats(
    service: State<'_, Service>,
    session_id: String,
) -> Result<weblink_desktop_capture::media::pipeline::PipelineStats, String> {
    run(service, move |s| Ok(s.media(session_id)?.pipeline_stats())).await
}

#[tauri::command]
pub async fn capture_close_peer(
    service: State<'_, Service>,
    session_id: String,
    peer_id: String,
) -> Result<(), String> {
    run(service, move |s| {
        s.media(session_id)?.close_peer(&peer_id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn capture_codecs() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(weblink_desktop_capture::media::MediaSession::codecs)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn capture_backends(service: State<'_, Service>) -> Result<CaptureCapabilities, String> {
    run(service, CaptureService::capabilities).await
}
#[tauri::command]
pub async fn capture_encoders() -> Result<Vec<weblink_desktop_capture::media::EncoderInfo>, String>
{
    tauri::async_runtime::spawn_blocking(weblink_desktop_capture::media::MediaSession::encoders)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn capture_set_audio_enabled(
    service: State<'_, Service>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    run(service, move |s| {
        s.media(session_id)?.set_audio_enabled(enabled);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn capture_update_video_settings(
    service: State<'_, Service>,
    session_id: String,
    settings: weblink_desktop_capture::media::VideoSettings,
) -> Result<(), String> {
    run(service, move |s| {
        s.media(session_id)?.update_video_settings(settings)
    })
    .await
}
