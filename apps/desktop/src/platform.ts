import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isExternalLink,
  type PlatformRuntime,
  type RuntimeCapabilities,
  type CaptureSource,
  type CaptureStatus,
} from "@weblink/platform";

export const platform: PlatformRuntime = {
  kind: "desktop",
  supportsServiceWorker: false,
  capture: {
    sources: () =>
      invoke<CaptureSource[]>("capture_sources"),
    start: (sourceId) =>
      invoke<CaptureStatus>("capture_start", { sourceId }),
    status: (sessionId) =>
      invoke<CaptureStatus>("capture_status", {
        sessionId,
      }),
    stop: (sessionId) =>
      invoke<CaptureStatus>("capture_stop", { sessionId }),
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
