import { createSignal, onCleanup, onMount } from "solid-js";
import type { NotificationCapabilities } from "@weblink/platform";
import { platform } from "@/libs/platform/runtime";

export function createNotificationPermission() {
  const [capabilities, setCapabilities] =
    createSignal<NotificationCapabilities>();
  const [status, setStatus] = createSignal<
    "loading" | "ready" | "error"
  >("loading");
  const [failure, setFailure] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  let refreshVersion = 0;
  let disposed = false;

  const refresh = async () => {
    const version = ++refreshVersion;
    if (!capabilities()) setStatus("loading");
    setFailure("");
    try {
      const value = platform.notifications
        ? await platform.notifications.capabilities()
        : {
            permission: "unavailable" as const,
            actions: false,
            reply: false,
          };
      if (disposed || version !== refreshVersion) return;
      setCapabilities(value);
      setStatus("ready");
    } catch (error) {
      console.warn(
        "Could not read system notification capabilities",
        error,
      );
      if (disposed || version !== refreshVersion) return;
      setCapabilities(undefined);
      setFailure(
        error instanceof Error
          ? error.message
          : String(error),
      );
      setStatus("error");
    }
  };
  const controller = new AbortController();
  let stopWatching: (() => void) | undefined;
  onMount(() => {
    void refresh();
    const changed = () => void refresh();
    window.addEventListener("focus", changed, {
      signal: controller.signal,
    });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible")
          changed();
      },
      { signal: controller.signal },
    );
    stopWatching =
      platform.notifications?.onPermissionChange?.(changed);
  });
  onCleanup(() => {
    disposed = true;
    controller.abort();
    stopWatching?.();
  });

  const requestPermission = async () => {
    if (!platform.notifications || busy() || disposed)
      return;
    setBusy(true);
    try {
      // No asynchronous work before this call: browsers require a user gesture.
      const permission =
        await platform.notifications.requestPermission();
      if (!disposed) await refresh();
      return permission;
    } finally {
      if (!disposed) setBusy(false);
    }
  };
  return {
    capabilities,
    status,
    failure,
    busy,
    refresh,
    requestPermission,
  };
}
