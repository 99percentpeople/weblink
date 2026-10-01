import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { videoPosition } from "@/libs/domain/remote-control/pointer";
import { useVideoDisplay } from "./video-display";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { appState } from "@/libs/state/app-state";
import { Trackpad } from "@/libs/domain/remote-control/trackpad";
import { DirectTouch } from "@/libs/domain/remote-control/direct-touch";
import { RemoteKeyboard } from "@/libs/domain/remote-control/keyboard";
import {
  exitControlShortcutLabel,
  resolveRemoteKeyboardOptions,
} from "@/libs/domain/remote-control/keyboard-options";
import { resolveRemoteTouchOptions } from "@/libs/domain/remote-control/touch-options";
import { createVideoRemoteControl } from "./remote-control-action";
import { platform } from "@/libs/platform/runtime";
import { NativeKeyboardForwarder } from "@/libs/application/native-keyboard";
export function RemoteControlOverlay(props: {
  enabled: boolean;
}) {
  const video = useVideoDisplay();
  const { control, state } = createVideoRemoteControl();
  let surface: HTMLDivElement | undefined;
  const held = new Set<number>();
  const fingers = new Set<number>();
  let trackpad: Trackpad | undefined;
  let direct: DirectTouch | undefined;
  let keyboard: RemoteKeyboard | undefined;
  const [focused, setFocused] = createSignal(false);
  const [systemKeyboard, setSystemKeyboard] =
    createSignal(false);
  createEffect(() => {
    let disposed = false;
    void platform.keyboard
      ?.supported()
      .then((supported) => {
        if (!disposed) setSystemKeyboard(supported);
      })
      .catch(() => {});
    onCleanup(() => {
      disposed = true;
    });
  });
  const touchOptions = createMemo(() =>
    resolveRemoteTouchOptions(appState.options.remoteTouch),
  );
  const keyboardOptions = createMemo(() =>
    resolveRemoteKeyboardOptions(
      appState.options.remoteKeyboard,
    ),
  );
  const nativeKeys = () =>
    systemKeyboard() &&
    keyboardOptions().enabled &&
    keyboardOptions().systemKeys &&
    control()?.supportsKeyboard();
  const clearTouches = () => {
    trackpad?.cancel();
    direct?.cancel();
    const ids = [...fingers];
    fingers.clear();
    for (const id of ids) {
      if (surface?.hasPointerCapture(id))
        surface.releasePointerCapture(id);
    }
  };
  const resetInput = () => {
    clearTouches();
    held.clear();
    keyboard?.clear();
    control()?.resetInput();
  };
  createEffect(() => {
    const c = control(),
      options = keyboardOptions();
    if (
      !nativeKeys() ||
      !props.enabled ||
      !focused() ||
      state() !== "active" ||
      !c ||
      !platform.keyboard
    )
      return;
    keyboard?.release();
    const forwarder = new NativeKeyboardForwarder(
      platform.keyboard,
      options.exitShortcut,
      {
        current: () =>
          props.enabled &&
          focused() &&
          c === control() &&
          c.state() === "active" &&
          !!nativeKeys() &&
          surface?.ownerDocument.activeElement ===
            surface &&
          !surface?.ownerDocument.hidden,
        input: (event) => c.input(event),
        reset: () => c.resetInput(),
        cancel: () => c.cancel(),
        stopped: (failed) => {
          setFocused(false);
          if (failed)
            toast.error(
              t("remote_control.system_keyboard_stopped"),
            );
        },
      },
    );
    onCleanup(() => forwarder.stop());
  });
  createEffect(() => {
    const c = control(),
      options = keyboardOptions();
    if (!c) return;
    const keys = new RemoteKeyboard(
      {
        input: (event) => c.input(event),
        cancel: () => {
          clearTouches();
          held.clear();
          c.cancel();
        },
      },
      options,
    );
    keyboard = keys;
    onCleanup(() => {
      keys.release();
      if (keyboard === keys) keyboard = undefined;
    });
  });
  createEffect(() => {
    const c = control(),
      options = touchOptions();
    if (!c) return;
    let warnedPan = false;
    const pad = new Trackpad(
      {
        move: (p) => c.move(p),
        input: (e) => c.input(e),
        position: () => c.position(),
        get relative() {
          return c.supportsRelativePointer()
            ? c.trackpad.bind(c)
            : undefined;
        },
        pan: (gesture) => {
          if (gesture.phase === "start") warnedPan = false;
          if (c.supportsTouchpadPan()) {
            c.trackpad({ type: "pan", ...gesture });
          } else if (
            gesture.phase === "update" &&
            !warnedPan
          ) {
            warnedPan = true;
            toast.error(
              t("setting.remote_control.pan_unavailable"),
            );
          }
        },
        size: () => {
          const v = video.videoRef();
          if (!v || !v.videoWidth || !v.videoHeight)
            return { width: 0, height: 0 };
          const rect = v.getBoundingClientRect();
          const scale = Math.min(
            rect.width / v.videoWidth,
            rect.height / v.videoHeight,
          );
          return {
            width: v.videoWidth * scale,
            height: v.videoHeight * scale,
          };
        },
      },
      options,
    );
    const touch = new DirectTouch((contacts) =>
      c.input({ type: "touch", contacts }),
    );
    trackpad = pad;
    direct = touch;
    onCleanup(() => {
      clearTouches();
      c.resetInput();
      trackpad = direct = undefined;
    });
  });
  createEffect(() => {
    const c = control();
    const ownerDocument =
      video.videoRef()?.ownerDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    if (!c) return;
    const life = new AbortController();
    c.addEventListener(
      "change",
      () => {
        if (c.state() !== "active") {
          held.clear();
          keyboard?.clear();
          clearTouches();
        }
      },
      { signal: life.signal },
    );
    ownerWindow.addEventListener(
      "blur",
      () => {
        setFocused(false);
        resetInput();
      },
      {
        signal: life.signal,
      },
    );
    ownerWindow.addEventListener(
      "focus",
      () => {
        if (ownerDocument.activeElement === surface)
          setFocused(true);
      },
      { signal: life.signal },
    );
    ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (ownerDocument.hidden) {
          setFocused(false);
          resetInput();
        }
      },
      { signal: life.signal },
    );
    onCleanup(() => {
      c.resetInput();
      life.abort();
      held.clear();
    });
  });
  createEffect(() => {
    if (!props.enabled) resetInput();
  });
  const point = (event: MouseEvent) => {
    const v = video.videoRef();
    if (!v) return;
    return videoPosition(
      v.getBoundingClientRect(),
      v.videoWidth,
      v.videoHeight,
      event.clientX,
      event.clientY,
    );
  };
  const touch = (
    event: PointerEvent,
    phase: "down" | "move" | "up",
  ) => {
    if (event.pointerType !== "touch") return false;
    if (state() !== "active") return true;
    event.preventDefault();
    event.stopPropagation();
    const id = event.pointerId;
    const isDirect = touchOptions().mode === "direct";
    if (phase === "down") {
      if (isDirect && !control()?.supportsTouch()) {
        toast.error(
          t("setting.remote_control.unavailable"),
        );
        return true;
      }
      const p = point(event);
      if (isDirect && !p) return true;
      const accepted = isDirect
        ? direct?.down(id, p!)
        : trackpad?.down(id, event.clientX, event.clientY);
      if (!accepted) {
        resetInput();
        return true;
      }
      if (state() !== "active") return true;
      fingers.add(id);
      surface?.setPointerCapture(id);
    } else if (fingers.has(id)) {
      if (isDirect) {
        const p = point(event);
        if (!p) {
          resetInput();
          return true;
        }
        if (phase === "move") direct?.move(id, p);
        else direct?.up(id, p);
      } else if (phase === "move")
        trackpad?.move(id, event.clientX, event.clientY);
      else trackpad?.up(id, event.clientX, event.clientY);
      if (phase === "up") {
        fingers.delete(id);
        if (surface?.hasPointerCapture(id))
          surface.releasePointerCapture(id);
      }
    }
    return true;
  };
  const button = (event: PointerEvent, down: boolean) => {
    if (
      state() !== "active" ||
      fingers.size > 0 ||
      event.pointerType !== "mouse" ||
      event.button < 0 ||
      event.button > 4
    )
      return;
    const p = point(event);
    if (!p) {
      resetInput();
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (down) {
      held.add(event.button);
      surface?.setPointerCapture(event.pointerId);
    } else held.delete(event.button);
    control()?.input({
      type: "button",
      ...p,
      button: event.button,
      down,
    });
    if (
      !down &&
      held.size === 0 &&
      surface?.hasPointerCapture(event.pointerId)
    )
      surface.releasePointerCapture(event.pointerId);
  };
  return (
    <Show when={props.enabled && state() !== "unavailable"}>
      <Show
        when={
          state() === "active" || state() === "activating"
        }
      >
        <div
          ref={surface}
          tabIndex={0}
          role="application"
          aria-label={t("remote_control.surface", {
            shortcut: exitControlShortcutLabel(
              keyboardOptions().exitShortcut,
            ),
          })}
          class="focus-visible:ring-primary absolute inset-0 z-10
            outline-none focus-visible:ring-2 focus-visible:ring-inset"
          style={{
            "touch-action": "none",
            "user-select": "none",
            "-webkit-touch-callout":
              touchOptions().mode === "direct"
                ? "none"
                : undefined,
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            resetInput();
          }}
          onKeyDown={(e) => {
            if (e.target !== e.currentTarget) return;
            const native = nativeKeys();
            if (native) keyboard?.exit(e);
            if (native || keyboard?.down(e)) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onKeyUp={(e) => {
            if (
              e.target === e.currentTarget &&
              (nativeKeys() || keyboard?.up(e))
            ) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onCompositionStart={() => keyboard?.release()}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // Mouse right-clicks already use pointerdown/up; direct touch
            // leaves press-and-hold recognition to the remote operating system.
            const pointerType = (e as PointerEvent)
              .pointerType;
            if (
              state() === "active" &&
              touchOptions().mode === "trackpad" &&
              fingers.size === 1 &&
              pointerType !== "mouse" &&
              pointerType !== "pen"
            )
              trackpad?.contextMenu();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onAuxClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => {
            surface?.focus({ preventScroll: true });
            setFocused(true);
            if (!touch(e, "down")) button(e, true);
          }}
          onPointerUp={(e) => {
            if (!touch(e, "up")) button(e, false);
          }}
          onPointerCancel={resetInput}
          onLostPointerCapture={(e) => {
            if (held.size || fingers.has(e.pointerId))
              resetInput();
          }}
          onPointerMove={(e) => {
            if (touch(e, "move")) return;
            if (e.pointerType !== "mouse" || fingers.size)
              return;
            const p = point(e);
            if (p) control()?.move(p);
            else if (held.size) resetInput();
          }}
          onPointerLeave={() => {
            if (held.size) resetInput();
          }}
          onWheel={(e) => {
            if (fingers.size) return;
            const p = point(e);
            if (!p || state() !== "active") return;
            e.preventDefault();
            e.stopPropagation();
            const unit =
              e.deltaMode === 1
                ? 40
                : e.deltaMode === 2
                  ? 120
                  : 1;
            const delta = (v: number) =>
              Math.max(
                -1200,
                Math.min(1200, Math.round(v * unit)),
              );
            control()?.input({
              type: "wheel",
              ...p,
              horizontal: delta(e.deltaX),
              vertical: -delta(e.deltaY),
            });
          }}
        />
      </Show>
    </Show>
  );
}
