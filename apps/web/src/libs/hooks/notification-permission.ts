import { createSignal, onCleanup, onMount } from "solid-js";
import type {
  NotificationCapabilities,
  SystemNotifications,
} from "@weblink/platform";

export function createNotificationPermission(
  notifications: SystemNotifications | undefined,
) {
  const [capabilities, setCapabilities] =
    createSignal<NotificationCapabilities>();
  const [status, setStatus] = createSignal<
    "loading" | "ready" | "error"
  >("loading");
  const [failure, setFailure] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [requestUnresolved, setRequestUnresolved] =
    createSignal(false);
  let refreshVersion = 0;
  let disposed = false;

  const refresh = async () => {
    if (disposed) return;
    const version = ++refreshVersion;
    if (!capabilities()) setStatus("loading");
    setFailure("");
    try {
      const value = notifications
        ? await notifications.capabilities()
        : {
            permission: "unavailable" as const,
            actions: false,
            reply: false,
          };
      if (disposed || version !== refreshVersion) return;
      if (
        value.permission !== "default" ||
        capabilities()?.permission !== value.permission
      )
        setRequestUnresolved(false);
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
    window.addEventListener("pageshow", changed, {
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
      notifications?.onPermissionChange?.(changed);
  });
  onCleanup(() => {
    disposed = true;
    controller.abort();
    stopWatching?.();
  });

  const requestPermission = async () => {
    if (
      !notifications ||
      busy() ||
      disposed ||
      capabilities()?.permission !== "default" ||
      requestUnresolved()
    )
      return;
    setBusy(true);
    try {
      // No asynchronous work before this call: browsers require a user gesture.
      const permission =
        await notifications.requestPermission();
      if (!disposed) {
        await refresh();
        if (
          !disposed &&
          capabilities()?.permission === "default" &&
          (permission === "granted" ||
            permission === "denied")
        )
          setCapabilities(
            (value) => value && { ...value, permission },
          );
        if (
          !disposed &&
          capabilities()?.permission === "default"
        )
          setRequestUnresolved(true);
      }
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
    requestUnresolved,
    requestPermission,
  };
}
