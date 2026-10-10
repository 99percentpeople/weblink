import { onCleanup, onMount } from "solid-js";
import { reconcile } from "solid-js/store";
import type { NativeRemoteControl } from "@weblink/platform";
import { appState, setAppState } from "./app-state";

/** App-owned discovery; mounting a settings view never starts a probe. */
export function createAppInputDevices(
  remoteControl:
    | Pick<NativeRemoteControl, "devices">
    | undefined,
) {
  const supported = !!remoteControl?.devices;
  setAppState("capabilities", "inputDevices", {
    supported,
    ready: !supported,
    refreshing: false,
    failed: false,
    snapshot: null,
  });
  const state = appState.capabilities.inputDevices;
  let disposed = false;
  let pending: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (disposed || !remoteControl?.devices)
      return Promise.resolve();
    if (pending) return pending;
    setAppState("capabilities", "inputDevices", {
      refreshing: true,
      failed: false,
    });
    pending = Promise.resolve()
      .then(() => remoteControl.devices!())
      .then((snapshot) => {
        if (disposed) return;
        setAppState(
          "capabilities",
          "inputDevices",
          "snapshot",
          reconcile(snapshot),
        );
      })
      .catch(() => {
        if (!disposed)
          setAppState(
            "capabilities",
            "inputDevices",
            "failed",
            true,
          );
      })
      .finally(() => {
        pending = undefined;
        if (!disposed)
          setAppState("capabilities", "inputDevices", {
            ready: true,
            refreshing: false,
          });
      });
    return pending;
  };

  onMount(() => {
    if (!supported) return;
    void refresh();
    const listener = new AbortController();
    window.addEventListener("focus", () => void refresh(), {
      signal: listener.signal,
    });
    onCleanup(() => listener.abort());
  });
  onCleanup(() => {
    disposed = true;
  });

  return { state, refresh };
}

export type AppInputDevices = ReturnType<
  typeof createAppInputDevices
>;
