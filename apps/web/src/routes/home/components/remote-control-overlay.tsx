import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { videoPosition } from "@/libs/domain/remote-control/pointer";
import { useVideoDisplay } from "@/routes/home/components/video-display-context";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { appState } from "@/libs/state/app-state";
import { Trackpad } from "@/libs/domain/remote-control/trackpad";
import { DirectTouch } from "@/libs/domain/remote-control/direct-touch";
import {
  touchMovementSamples,
  touchSample,
} from "@/libs/domain/remote-control/touch-sampling";
import type { TrackpadEvent } from "@/libs/domain/remote-control/trackpad-types";
import { ThreeFingerTap } from "@/libs/domain/remote-control/three-finger-tap";
import { RemoteKeyboard } from "@/libs/domain/remote-control/keyboard";
import {
  exitControlShortcutLabel,
  resolveRemoteKeyboardOptions,
} from "@/libs/domain/remote-control/keyboard-options";
import { createRemotePointerCapture } from "@/libs/hooks/remote-pointer-capture";
import { resolveRemotePointerOptions } from "@/libs/domain/remote-control/pointer-options";
import { resolveRemoteTouchOptions } from "@/libs/domain/remote-control/touch-options";
import { createVideoRemoteControl } from "./remote-control-action";
import { platform } from "@/libs/platform/runtime";
import { NativeKeyboardForwarder } from "@/libs/application/native-keyboard";
import type { RemoteKeyboardInputHandle } from "./remote-keyboard-input";
export function RemoteControlOverlay(props: {
  enabled: boolean;
  keyboard?: () => RemoteKeyboardInputHandle | undefined;
}) {
  const video = useVideoDisplay();
  const { control, state } = createVideoRemoteControl();
  const [surface, setSurface] =
    createSignal<HTMLDivElement>();
  let captureClick = false;
  const held = new Set<number>();
  const fingers = new Set<number>();
  const threeFingerTap = new ThreeFingerTap();
  let shortcutEnabled = false;
  let nativeTouchEvents = false;
  let pendingKeyboard:
    | RemoteKeyboardInputHandle
    | undefined;
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
  const captureMode = () =>
    resolveRemotePointerOptions(
      appState.options.remotePointer,
    ).mode === "capture";
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
    threeFingerTap.cancel();
    shortcutEnabled = false;
    nativeTouchEvents = false;
    pendingKeyboard = undefined;
    trackpad?.cancel();
    direct?.cancel();
    const ids = [...fingers];
    fingers.clear();
    for (const id of ids) {
      if (surface()?.hasPointerCapture(id))
        surface()!.releasePointerCapture(id);
    }
  };
  const resetInput = () => {
    clearTouches();
    held.clear();
    keyboard?.clear();
    control()?.resetInput();
  };
  const capture = createRemotePointerCapture({
    element: surface,
    enabled: () =>
      props.enabled &&
      state() === "active" &&
      captureMode(),
    released: resetInput,
    failed: () =>
      toast.error(t("remote_control.capture_failed")),
  });
  const captured = () =>
    capture.active() &&
    surface()?.ownerDocument.pointerLockElement ===
      surface();
  const keyboardActive = () =>
    props.enabled &&
    focused() &&
    state() === "active" &&
    (!captureMode() || captured());
  const stopInput = () => {
    captureClick = false;
    const wasCaptured = capture.active();
    capture.release();
    if (!wasCaptured) resetInput();
  };
  const releaseControls = () => {
    const element = surface();
    if (
      element &&
      element.ownerDocument.activeElement === element
    )
      element.blur(); // onBlur releases pointer capture and held input together.
    else stopInput();
  };
  const contentSize = () => {
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
  };
  createEffect(() => {
    const c = control(),
      options = keyboardOptions();
    if (
      !keyboardActive() ||
      !nativeKeys() ||
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
          keyboardActive() &&
          c === control() &&
          c.state() === "active" &&
          !!nativeKeys() &&
          surface()?.ownerDocument.activeElement ===
            surface() &&
          !surface()?.ownerDocument.hidden,
        input: (event) => c.input(event),
        reset: () => c.resetInput(),
        cancel: releaseControls,
        stopped: (failed) => {
          if (focused() || capture.active())
            releaseControls();
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
        cancel: releaseControls,
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
        move: (p) => c.move(p, options.sampleRate),
        input: (e) => c.input(e),
        position: () => c.position(),
        get relative() {
          return c.supportsRelativePointer()
            ? (event: TrackpadEvent) =>
                c.trackpad(event, options.sampleRate)
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
        size: contentSize,
      },
      options,
    );
    const touch = new DirectTouch(
      (contacts) => c.input({ type: "touch", contacts }),
      options.sampleRate,
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
          capture.release();
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
        stopInput();
      },
      {
        signal: life.signal,
      },
    );
    ownerWindow.addEventListener(
      "focus",
      () => {
        if (ownerDocument.activeElement === surface())
          setFocused(true);
      },
      { signal: life.signal },
    );
    ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (ownerDocument.hidden) {
          setFocused(false);
          stopInput();
        }
      },
      { signal: life.signal },
    );
    onCleanup(() => {
      capture.release();
      c.resetInput();
      life.abort();
      held.clear();
    });
  });
  createEffect(() => {
    if (!props.enabled) stopInput();
  });
  const point = (event: MouseEvent, clamp = false) => {
    const v = video.videoRef();
    if (!v) return;
    return videoPosition(
      v.getBoundingClientRect(),
      v.videoWidth,
      v.videoHeight,
      event.clientX,
      event.clientY,
      clamp,
    );
  };
  const touch = (
    event: PointerEvent,
    phase: "down" | "move" | "up" | "cancel",
  ) => {
    if (event.pointerType !== "touch") return false;
    if (phase === "cancel") {
      if (fingers.has(event.pointerId)) {
        const native = nativeTouchEvents;
        cancelTouch();
        if (!native) showPendingKeyboard();
      }
      return true;
    }
    if (state() !== "active") return true;
    event.preventDefault();
    event.stopPropagation();
    const id = event.pointerId;
    const isDirect = touchOptions().mode === "direct";
    if (phase === "down") {
      if (!fingers.size) {
        nativeTouchEvents = false;
        pendingKeyboard = undefined;
        shortcutEnabled =
          !isDirect &&
          touchOptions().threeFingerTap === "keyboard" &&
          props.keyboard?.()?.available() === true;
      }
      if (isDirect && !control()?.supportsTouch()) {
        toast.error(
          t("setting.remote_control.unavailable"),
        );
        return true;
      }
      const p = point(event);
      if (isDirect && !p) return true;
      const wasConsumed = threeFingerTap.consumed;
      if (shortcutEnabled)
        threeFingerTap.down(
          id,
          event.clientX,
          event.clientY,
        );
      if (threeFingerTap.consumed && !wasConsumed) {
        // Cancel remote contacts before the local shortcut moves focus to IME.
        trackpad?.cancel();
        direct?.cancel();
        if (state() !== "active") return true;
      }
      const accepted =
        threeFingerTap.consumed ||
        (isDirect
          ? direct?.down(
              id,
              touchSample(
                event,
                p!,
                contentSize(),
                touchOptions().forwardProperties,
              ),
            )
          : trackpad?.down(
              id,
              event.clientX,
              event.clientY,
            ));
      if (!accepted) {
        resetInput();
        return true;
      }
      if (state() !== "active") return true;
      fingers.add(id);
      surface()?.setPointerCapture(id);
    } else if (fingers.has(id)) {
      const consumed = threeFingerTap.consumed;
      let showKeyboard = false;
      if (phase === "move")
        threeFingerTap.move(
          id,
          event.clientX,
          event.clientY,
        );
      else
        showKeyboard = threeFingerTap.up(
          id,
          event.clientX,
          event.clientY,
        );
      if (!consumed && isDirect) {
        const p = point(event, true);
        if (!p) {
          direct?.cancel();
        } else if (phase === "move")
          direct?.move(
            id,
            touchSample(
              event,
              p,
              contentSize(),
              touchOptions().forwardProperties,
            ),
          );
        else direct?.up(id, p);
      } else if (!consumed && phase === "move")
        trackpad?.move(id, event.clientX, event.clientY);
      else if (!consumed)
        trackpad?.up(id, event.clientX, event.clientY);
      if (phase === "up") {
        fingers.delete(id);
        if (surface()?.hasPointerCapture(id))
          surface()!.releasePointerCapture(id);
        if (showKeyboard) {
          if (nativeTouchEvents)
            pendingKeyboard = props.keyboard?.();
          else props.keyboard?.()?.show();
        }
      }
    }
    return true;
  };
  const showPendingKeyboard = () => {
    const keyboard = pendingKeyboard;
    pendingKeyboard = undefined;
    if (
      props.enabled &&
      keyboard === props.keyboard?.() &&
      keyboard?.available()
    )
      keyboard.show();
  };
  const cancelTouch = () => {
    const action = threeFingerTap.finish()
      ? props.keyboard?.()
      : undefined;
    // The third contact already cancelled the remote gesture. Keep an existing
    // IME composition alive instead of restarting the control session for it.
    if (action && !held.size) clearTouches();
    else resetInput();
    pendingKeyboard = action;
  };
  const nativeTouch = (event: TouchEvent) => {
    // The native events share lifecycle handling; only the validated three-finger
    // shortcut can complete on cancellation. Other gestures are just cancelled.
    // Preserve the browser's single-finger contextmenu recognition. touch-action
    // blocks viewport panning; cancelling touchstart also suppresses long press.
    if (
      event.type === "touchend" ||
      event.type === "touchcancel" ||
      event.touches.length > 1
    )
      event.preventDefault();
    event.stopPropagation();
    switch (event.type) {
      case "touchstart":
        if (fingers.size) nativeTouchEvents = true;
        break;
      case "touchend":
        if (!event.touches.length) showPendingKeyboard();
        break;
      case "touchcancel":
        if (fingers.size) cancelTouch();
        showPendingKeyboard();
        break;
    }
  };
  const button = (event: PointerEvent, down: boolean) => {
    if (
      state() !== "active" ||
      captureMode() ||
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
      surface()?.setPointerCapture(event.pointerId);
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
      surface()?.hasPointerCapture(event.pointerId)
    )
      surface()!.releasePointerCapture(event.pointerId);
  };
  const capturedButton = (
    event: MouseEvent,
    down: boolean,
  ) => {
    if (
      !captured() ||
      state() !== "active" ||
      fingers.size ||
      event.button < 0 ||
      event.button > 4
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (down) held.add(event.button);
    else if (!held.delete(event.button)) return;
    control()?.trackpad({
      type: "button",
      button: event.button,
      down,
    });
  };
  return (
    <Show when={props.enabled && state() !== "unavailable"}>
      <Show
        when={
          state() === "active" || state() === "activating"
        }
      >
        <div
          ref={setSurface}
          tabIndex={0}
          role="application"
          aria-label={t("remote_control.surface", {
            shortcut: exitControlShortcutLabel(
              keyboardOptions().exitShortcut,
            ),
          })}
          title={
            captureMode()
              ? t("remote_control.capture_hint", {
                  shortcut: exitControlShortcutLabel(
                    keyboardOptions().exitShortcut,
                  ),
                })
              : undefined
          }
          class="meeting-tile-focus-target absolute inset-0 z-10 outline-none"
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
            stopInput();
          }}
          onKeyDown={(e) => {
            if (
              e.target !== e.currentTarget ||
              !keyboardActive()
            )
              return;
            const native = nativeKeys();
            if (native) keyboard?.exit(e);
            if (native || keyboard?.down(e)) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onKeyUp={(e) => {
            if (
              keyboardActive() &&
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
            if (!captureClick) return;
            captureClick = false;
            if (control()?.supportsRelativePointer())
              capture.request();
            else
              toast.error(
                t("remote_control.capture_unavailable"),
              );
          }}
          onAuxClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => {
            // Pointer input can run while the text editor owns keyboard input.
            // Both explicit focus and the browser's default focus would hide IME.
            const keyboard = props.keyboard?.();
            if (keyboard?.focused()) {
              keyboard.suppressAutomaticShow();
              e.preventDefault();
            } else {
              surface()?.focus({ preventScroll: true });
              setFocused(true);
            }
            if (!touch(e, "down")) button(e, true);
          }}
          onMouseDown={(e) => {
            if (props.keyboard?.()?.focused())
              e.preventDefault();
            if (!captureMode()) return;
            captureClick =
              !captured() &&
              e.button === 0 &&
              state() === "active" &&
              !fingers.size;
            capturedButton(e, true);
          }}
          onMouseUp={(e) => capturedButton(e, false)}
          onMouseMove={(e) => {
            if (
              !captured() ||
              state() !== "active" ||
              fingers.size
            )
              return;
            const { width, height } = contentSize();
            if (
              width > 0 &&
              height > 0 &&
              (e.movementX || e.movementY)
            )
              control()?.trackpad({
                type: "move",
                x: e.movementX / width,
                y: e.movementY / height,
              });
          }}
          on:touchstart={nativeTouch}
          on:touchmove={nativeTouch}
          on:touchend={nativeTouch}
          on:touchcancel={nativeTouch}
          onPointerUp={(e) => {
            if (!touch(e, "up")) button(e, false);
          }}
          onPointerCancel={(e) => {
            if (!touch(e, "cancel") && held.size)
              resetInput();
          }}
          onLostPointerCapture={(e) => {
            if (held.size || fingers.has(e.pointerId))
              resetInput();
          }}
          onPointerMove={(e) => {
            if (e.pointerType === "touch") {
              e.preventDefault();
              e.stopPropagation();
              for (const sample of touchMovementSamples(e))
                touch(sample, "move");
              return;
            }
            if (
              captureMode() ||
              e.pointerType !== "mouse" ||
              fingers.size
            )
              return;
            const p = point(e);
            if (p) control()?.move(p);
            else if (held.size) resetInput();
          }}
          onPointerLeave={() => {
            if (!captured() && held.size) resetInput();
          }}
          onWheel={(e) => {
            if (fingers.size) return;
            if (captureMode() && !captured()) return;
            const p = point(e);
            if ((!captured() && !p) || state() !== "active")
              return;
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
            const wheel = {
              type: "wheel" as const,
              horizontal: delta(e.deltaX),
              vertical: -delta(e.deltaY),
            };
            if (captured()) control()?.trackpad(wheel);
            else control()?.input({ ...wheel, ...p! });
          }}
        />
      </Show>
    </Show>
  );
}
