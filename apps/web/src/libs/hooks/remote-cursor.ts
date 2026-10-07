import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type Accessor,
} from "solid-js";
import {
  cursorGeometry,
  type RemoteCursorImage,
  type RemoteCursorShape,
  type RemoteCursorOwner,
} from "../domain/protocol/remote-control/cursor";
import type { RemotePointer } from "../domain/remote-control/pointer";

export type LocalCursorFrame = {
  image: HTMLImageElement;
  shape: RemoteCursorImage;
  durationMs: number;
};
export type LocalCursorRenderer = {
  paint: (frame: LocalCursorFrame | undefined) => boolean;
  watchFailure: (listener: () => void) => () => void;
};

/** Local mouse mode only. Captured/relative input continues to use the video cursor. */
export function createRemoteCursor(
  control: Accessor<RemotePointer | undefined>,
  enabled: Accessor<boolean>,
  synchronize: Accessor<boolean> = () => true,
  renderer?: LocalCursorRenderer,
): Accessor<string | undefined> {
  const paint = renderer?.paint;
  const [cursor, setCursor] = createSignal<string>();
  const decoded = new WeakMap<
    RemoteCursorShape,
    LocalCursorFrame[]
  >();
  // A drag moving back inside changes hover state without ending cursor ownership.
  const target = createMemo(() =>
    enabled() ? control() : undefined,
  );
  const sync = createMemo(synchronize);
  createEffect(() => {
    const c = target();
    if (!c) return;
    let pending: HTMLImageElement[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let revision = 0;
    let localReady = false;
    let current: RemoteCursorShape | undefined;
    const clear = () => {
      ++revision;
      for (const image of pending)
        image.onload = image.onerror = null;
      pending = [];
      clearTimeout(timer);
      timer = undefined;
    };
    const show = (style: string, local: boolean) => {
      setCursor(style);
      c.setCursorVisible(!local);
    };
    const fallback = () => {
      clear();
      localReady = false;
      paint?.(undefined);
      show("none", false);
    };
    const display = (
      shape: RemoteCursorShape,
      frames: LocalCursorFrame[],
    ) => {
      if (shape.type === "image") {
        const geometry = cursorGeometry(shape);
        const url = `url("data:image/png;base64,${shape.png}")`;
        const image =
          shape.sourceScale === 100
            ? url
            : `image-set(${url} ${shape.sourceScale / 100}x)`;
        const style = `${image} ${geometry.hotspotX} ${geometry.hotspotY}, default`;
        if (
          shape.sourceScale === 100 ||
          globalThis.CSS?.supports("cursor", style)
        ) {
          paint?.(undefined);
          localReady = true;
          show(style, true);
        } else {
          // A browser without density-aware CSS cursors can still draw the original pixels at the correct size.
          if (!paint?.(frames[0])) return fallback();
          localReady = true;
          show("none", true);
        }
        return;
      }
      if (!paint || !paint(frames[0])) return fallback();
      localReady = true;
      show("none", true);
      const start = performance.now();
      const duration = frames.reduce(
        (sum, frame) => sum + frame.durationMs,
        0,
      );
      let shown = 0;
      const tick = () => {
        // Time-based playback skips delayed frames instead of accumulating timer drift.
        let phase = (performance.now() - start) % duration;
        let index = 0;
        while (phase >= frames[index].durationMs)
          phase -= frames[index++].durationMs;
        if (shown !== index && !paint(frames[index]))
          return fallback();
        shown = index;
        timer = setTimeout(
          tick,
          Math.max(1, frames[index].durationMs - phase),
        );
      };
      timer = setTimeout(tick, frames[0].durationMs);
    };
    const apply = (
      shape: RemoteCursorShape | undefined,
      owner: RemoteCursorOwner,
    ) => {
      if (owner === "host") {
        current = undefined;
        clear();
        localReady = false;
        paint?.(undefined);
        // Capture composition was already changed by the host. Do not echo a
        // visibility request or discard its remembered viewer preference.
        setCursor("none");
        return;
      }
      if (shape && shape === current) return;
      current = shape;
      clear();
      if (!shape || shape.type === "system") {
        paint?.(undefined);
        localReady = true;
        return show(shape?.name ?? "default", true);
      }
      if (shape.type === "unknown") return fallback();
      const cached = decoded.get(shape);
      if (cached) return display(shape, cached);
      // Keep a usable local cursor during decoding, avoiding a hide/show network pair on every change.
      if (!localReady) show("none", false);
      const version = revision;
      const source =
        shape.type === "image"
          ? [{ image: shape, durationMs: 100 }]
          : shape.frames;
      const images = new Map<string, HTMLImageElement>();
      const frames = source.map((frame) => {
        let image = images.get(frame.image.png);
        if (!image) {
          image = new Image();
          images.set(frame.image.png, image);
          pending.push(image);
        }
        return {
          image,
          shape: frame.image,
          durationMs: frame.durationMs,
        };
      });
      let remaining = images.size;
      for (const [png, image] of images) {
        image.onload = () => {
          if (version !== revision) return;
          if (
            frames.some(
              (frame) =>
                frame.image === image &&
                (image.naturalWidth !== frame.shape.width ||
                  image.naturalHeight !==
                    frame.shape.height),
            )
          )
            return fallback();
          if (--remaining) return;
          clear();
          decoded.set(shape, frames);
          display(shape, frames);
        };
        image.onerror = () => {
          if (version === revision) fallback();
        };
        image.src = `data:image/png;base64,${png}`;
      }
    };
    const stopFailure = renderer?.watchFailure(fallback);
    const appearance = sync();
    const stop = c.watchCursor(
      (shape, owner) =>
        apply(appearance ? shape : undefined, owner),
      appearance,
    );
    onCleanup(() => {
      stopFailure?.();
      stop();
      clear();
      paint?.(undefined);
      setCursor(undefined);
      c.setCursorVisible(true);
    });
  });
  return cursor;
}
