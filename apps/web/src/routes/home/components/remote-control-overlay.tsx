import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Button } from "@/components/ui/button";
import { sessionService } from "@/libs/application/session-service";
import {
  videoPosition,
  type PointerState,
} from "@/libs/domain/remote-control/pointer";
import { useVideoDisplay } from "./video-display";
import { t } from "@/i18n";
export function RemoteControlOverlay(props: {
  enabled: boolean;
}) {
  const video = useVideoDisplay();
  const control = createMemo(() => {
    const track = video.videoTrack();
    return track
      ? sessionService.getRemoteControl(track)
      : undefined;
  });
  const [state, setState] =
    createSignal<PointerState>("unavailable");
  let surface: HTMLDivElement | undefined;
  const held = new Set<number>();
  const pause = () => {
    held.clear();
    control()?.pause();
  };
  createEffect(() => {
    const c = control();
    const ownerDocument =
      video.videoRef()?.ownerDocument ?? document;
    const ownerWindow = ownerDocument.defaultView ?? window;
    setState(c?.state() ?? "unavailable");
    if (!c) return;
    const life = new AbortController();
    c.addEventListener(
      "change",
      () => {
        setState(c.state());
        if (c.state() !== "active") held.clear();
      },
      { signal: life.signal },
    );
    ownerWindow.addEventListener("blur", pause, {
      signal: life.signal,
    });
    ownerDocument.addEventListener(
      "visibilitychange",
      () => {
        if (ownerDocument.hidden) pause();
      },
      { signal: life.signal },
    );
    onCleanup(() => {
      c.pause();
      life.abort();
      held.clear();
    });
  });
  createEffect(() => {
    if (!props.enabled) pause();
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
  const button = (event: PointerEvent, down: boolean) => {
    if (
      state() !== "active" ||
      event.pointerType !== "mouse" ||
      event.button < 0 ||
      event.button > 4
    )
      return;
    const p = point(event);
    if (!p) {
      pause();
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
  createEffect(() => {
    if (state() === "activating" || state() === "active")
      surface?.focus({ preventScroll: true });
  });
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
          aria-label={t("remote_control.surface")}
          class="focus-visible:ring-primary absolute inset-0 z-10
            outline-none focus-visible:ring-2 focus-visible:ring-inset"
          onBlur={pause}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              pause();
            }
          }}
          onContextMenu={(e) => e.preventDefault()}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onAuxClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onPointerDown={(e) => button(e, true)}
          onPointerUp={(e) => button(e, false)}
          onPointerCancel={pause}
          onLostPointerCapture={() => {
            if (held.size) pause();
          }}
          onPointerMove={(e) => {
            const p = point(e);
            if (p) control()?.move(p);
            else if (held.size) pause();
          }}
          onPointerLeave={() => {
            if (held.size) pause();
          }}
          onWheel={(e) => {
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
      <div
        class="bg-background/95 absolute left-3 top-3 z-20 flex
          items-center gap-2 rounded-md p-1.5 text-xs shadow-sm"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <Show when={state() === "viewing"}>
          <Button
            size="sm"
            variant="outline"
            onClick={() => control()?.request()}
          >
            {t("remote_control.request")}
          </Button>
        </Show>
        <Show when={state() === "requesting"}>
          <span>{t("remote_control.waiting")}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => control()?.cancel()}
          >
            {t("remote_control.cancel")}
          </Button>
        </Show>
        <Show when={state() === "paused"}>
          <Button
            size="sm"
            onClick={() => control()?.activate()}
          >
            {t("remote_control.resume")}
          </Button>
        </Show>
        <Show
          when={
            state() === "active" || state() === "activating"
          }
        >
          <Button
            size="sm"
            variant="outline"
            onClick={pause}
          >
            {t("remote_control.pause")}
          </Button>
        </Show>
        <Show
          when={["active", "activating", "paused"].includes(
            state(),
          )}
        >
          <Button
            size="sm"
            variant="ghost"
            onClick={() => control()?.cancel()}
          >
            {t("remote_control.end")}
          </Button>
        </Show>
      </div>
    </Show>
  );
}
