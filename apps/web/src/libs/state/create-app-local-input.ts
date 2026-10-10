import { onCleanup, onMount } from "solid-js";
import { isKeyboardEvidence } from "@/libs/domain/remote-control/local-input";
import { appState, setAppState } from "./app-state";

/** Local device discovery remains active even when forwarding is disabled. */
export function createAppLocalInput() {
  onMount(() => {
    const windows = new Map<Window, AbortController>();
    const observe = (view: Window) => {
      if (windows.has(view)) return;
      const listeners = new AbortController();
      const { signal } = listeners;
      windows.set(view, listeners);
      const refresh = () => {
        try {
          const pads = view.navigator.getGamepads?.() ?? [];
          setAppState(
            "capabilities",
            "localInput",
            "gamepadCount",
            Array.from(pads).filter(
              (pad) =>
                pad?.connected &&
                pad.mapping === "standard",
            ).length,
          );
        } catch {
          // The API can be blocked by browser permissions policy.
          setAppState(
            "capabilities",
            "localInput",
            "gamepadCount",
            0,
          );
        }
      };
      view.addEventListener("gamepadconnected", refresh, {
        signal,
      });
      view.addEventListener(
        "gamepaddisconnected",
        refresh,
        { signal },
      );
      view.addEventListener("focus", refresh, { signal });
      view.document.addEventListener(
        "visibilitychange",
        () => {
          if (!view.document.hidden) refresh();
        },
        { signal },
      );
      view.addEventListener(
        "keydown",
        (event) => {
          const state = appState.capabilities.localInput;
          if (!state.mobile || state.keyboardObserved)
            return;
          const editable = event
            .composedPath()
            .some(
              (target) =>
                typeof (target as Element).closest ===
                  "function" &&
                !!(target as Element).closest(
                  "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox]",
                ),
            );
          if (isKeyboardEvidence(event, editable))
            setAppState(
              "capabilities",
              "localInput",
              "keyboardObserved",
              true,
            );
        },
        { signal, capture: true },
      );
      view.addEventListener(
        "pagehide",
        () => {
          // Preserve observation when a document enters the back/forward cache.
          if (view === window) return;
          listeners.abort();
          windows.delete(view);
        },
        { signal },
      );
      refresh();
    };
    observe(window);
    const pip = (
      window as Window & {
        documentPictureInPicture?: EventTarget & {
          window?: Window;
        };
      }
    ).documentPictureInPicture;
    if (pip?.window) observe(pip.window);
    pip?.addEventListener?.(
      "enter",
      (event) => {
        observe(
          (event as Event & { window: Window }).window,
        );
      },
      { signal: windows.get(window)!.signal },
    );
    onCleanup(() => {
      for (const listeners of windows.values())
        listeners.abort();
      windows.clear();
    });
  });
}
