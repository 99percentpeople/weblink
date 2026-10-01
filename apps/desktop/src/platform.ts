import { Channel, invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { createRawPreview } from "./preview";
import {
  isExternalLink,
  type PlatformRuntime,
  type RuntimeCapabilities,
  type CaptureSource,
  type DisplayLayout,
  type CaptureStatus,
  type CaptureCapabilities,
  type NativeEncoder,
} from "@weblink/platform";

export const platform: PlatformRuntime = {
  kind: "desktop",
  supportsServiceWorker: false,
  remoteControl: {
    open: () => invoke("remote_control_open"),
    status: (ownerId) =>
      invoke("remote_control_status", { ownerId }),
    end: (ownerId) =>
      invoke("remote_control_end", { ownerId }),
    revoke: (ownerId) =>
      invoke("remote_control_revoke", { ownerId }),
    approve: (ownerId, consentId, approve) =>
      invoke("remote_control_approve", {
        ownerId,
        consentId,
        approve,
      }),
  },
  capture: {
    displayLayout: () =>
      invoke<DisplayLayout>("capture_display_layout"),
    sources: () =>
      invoke<CaptureSource[]>("capture_sources"),
    backends: () =>
      invoke<CaptureCapabilities>("capture_backends"),
    thumbnail: async (sourceId, options) => {
      const image = await invoke<ArrayBuffer>(
        "capture_thumbnail",
        {
          sourceId,
          options: options ?? {},
        },
      );
      return new Blob([image], { type: "image/png" });
    },
    start: (sourceId, options) =>
      invoke<CaptureStatus>("capture_start", {
        sourceId,
        options: options ?? {},
      }),
    status: (sessionId) =>
      invoke<CaptureStatus>("capture_status", {
        sessionId,
      }),
    stop: (sessionId) =>
      invoke<CaptureStatus>("capture_stop", { sessionId }),
  },
  screenShare: {
    preview: createRawPreview,
    stats: (sessionId, peerId) =>
      invoke<
        import("@weblink/platform").NativeVideoStats[]
      >("capture_video_stats", { sessionId, peerId }),
    updateVideoSettings: (sessionId, settings) =>
      invoke<void>("capture_update_video_settings", {
        sessionId,
        settings,
      }),
    setAudioEnabled: (sessionId, enabled) =>
      invoke<void>("capture_set_audio_enabled", {
        sessionId,
        enabled,
      }),
    codecs: () => invoke<string[]>("capture_codecs"),
    encoders: () =>
      invoke<NativeEncoder[]>("capture_encoders"),
    start: (sourceId, options, capture) =>
      invoke<CaptureStatus>("capture_share_start", {
        sourceId,
        options: options ?? {},
        capture: capture ?? {},
      }),
    offer: (
      sessionId,
      peerId,
      iceServers,
      relayOnly,
      preview = false,
      onCandidate,
      control,
    ) =>
      invoke<string>("capture_offer", {
        sessionId,
        ...(control ? { control } : {}),
        peerId,
        relayOnly,
        preview,
        ...(onCandidate
          ? { candidates: new Channel(onCandidate) }
          : {}),
        iceServers: iceServers.map((server) => ({
          urls:
            typeof server.urls === "string"
              ? [server.urls]
              : server.urls,
          username: server.username ?? "",
          credential: server.credential ?? "",
        })),
      }),
    addIceCandidate: (sessionId, peerId, candidate) =>
      invoke<void>("capture_add_ice_candidate", {
        sessionId,
        peerId,
        candidate,
      }),
    answer: (sessionId, peerId, sdp) =>
      invoke<void>("capture_answer", {
        sessionId,
        peerId,
        sdp,
      }),
    closePeer: (sessionId, peerId) =>
      invoke<void>("capture_close_peer", {
        sessionId,
        peerId,
      }),
  },
  getCapabilities: () =>
    invoke<RuntimeCapabilities>("runtime_capabilities"),
  initialize() {
    const controller = new AbortController();
    const openLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button > 1)
        return;
      const target = event
        .composedPath()
        .find(
          (item): item is HTMLAnchorElement =>
            item instanceof HTMLAnchorElement,
        );
      if (!target || target.hasAttribute("download"))
        return;
      let url: URL;
      try {
        url = new URL(target.href, window.location.href);
      } catch {
        event.preventDefault();
        return;
      }
      // Custom WebView protocols can serialize URL.origin as "null".
      if (
        url.protocol === window.location.protocol &&
        url.host === window.location.host
      )
        return;
      event.preventDefault();
      if (!isExternalLink(url)) return;
      void openUrl(url.href).catch((error: unknown) => {
        console.error(
          "Could not open external link",
          error,
        );
      });
    };
    document.addEventListener("click", openLink, {
      signal: controller.signal,
    });
    document.addEventListener("auxclick", openLink, {
      signal: controller.signal,
    });
    return () => controller.abort();
  },
};
