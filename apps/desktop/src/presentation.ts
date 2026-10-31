import "./presentation.css";
import { openPresentationRecording } from "./presentation-recording";
import { createNativePresentationStats } from "./presentation-stats";
import { Channel, invoke } from "@tauri-apps/api/core";
import {
  createPresentationLayout,
  type SurfaceRect,
} from "./presentation-layout";

export interface GpuStats {
  path: string;
  presentedFrames: number;
  uploadedFrames: number;
  decodedQueueMs: number;
  submitMs: number;
  error?: string;
}
export interface GpuSurface {
  id: string;
  stream: MediaStream;
  size: { width: number; height: number };
  latestStats?: GpuStats;
  statsAt: number;
  visible: boolean;
  open(): Promise<void>;
  ready: Promise<void>;
  close(): void;
  stats(): Promise<GpuStats>;
  layout(
    value: Record<string, number | boolean>,
  ): Promise<void>;
  fail(error: unknown): void;
  closed: boolean;
  bound?: () => void;
}
export function createNativePresentation(
  watchVisibility?: (
    changed: (visible: boolean) => void,
  ) => () => void,
) {
  const sources = new WeakMap<
    MediaStreamTrack,
    GpuSurface
  >();
  const layout = createPresentationLayout();
  return {
    sample(track: MediaStreamTrack) {
      const surface = sources.get(track);
      if (!surface) return;
      return createNativePresentationStats(() => ({
        at: surface.statsAt,
        frames: surface.latestStats?.presentedFrames ?? 0,
        visible:
          !surface.closed &&
          surface.visible &&
          !!surface.latestStats &&
          performance.now() - surface.statsAt < 3000,
      }));
    },
    recording(track: MediaStreamTrack) {
      const surface = sources.get(track);
      if (!surface || surface.closed) return;
      return (
        signal: AbortSignal,
        ended: (error?: Error) => void,
      ) =>
        openPresentationRecording(
          surface.id,
          () => surface.closed,
          signal,
          ended,
        );
    },
    create(
      sourceId: string,
      preview: boolean,
      track: () => void,
      ended: () => void,
      fail: (error: unknown) => void,
    ): GpuSurface {
      const id = crypto.randomUUID();
      // This track carries dimensions and the existing media/control lifecycle.
      // Its black pixels are masked after the native surface has presented.
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const stream = canvas.captureStream(0);
      const placeholder =
        stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
      let resolve!: () => void,
        reject!: (error: unknown) => void;
      const ready = new Promise<void>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      void ready.catch(() => {});
      let opening: Promise<unknown> | undefined;
      let layoutTail = Promise.resolve();
      let refresh:
        | ReturnType<typeof setInterval>
        | undefined;
      let renewing = false;
      const draw = () => {
        canvas
          .getContext("2d")!
          .fillRect(0, 0, canvas.width, canvas.height);
        placeholder.requestFrame();
      };
      const surface: GpuSurface = {
        id,
        stream,
        size: { width: 0, height: 0 },
        statsAt: 0,
        visible: false,
        ready,
        closed: false,
        fail,
        async open() {
          if (surface.closed)
            throw new DOMException(
              "Native surface closed",
              "AbortError",
            );
          const events = new Channel<{
            type: string;
            width?: number;
            height?: number;
            error?: string;
          }>((event) => {
            if (surface.closed) return;
            if (event.type === "error") {
              fail(
                new Error(
                  event.error ??
                    "Native presentation failed",
                ),
              );
              return;
            }
            if (event.type === "ended") {
              ended();
              surface.close();
              return;
            }
            if (event.type !== "surface") return;
            const width = event.width!,
              height = event.height!;
            if (
              !Number.isInteger(width) ||
              !Number.isInteger(height) ||
              width < 2 ||
              height < 2 ||
              width > 3840 ||
              height > 2160
            ) {
              fail(
                new Error(
                  "Invalid native surface dimensions",
                ),
              );
              return;
            }
            surface.size = { width, height };
            canvas.width = width;
            canvas.height = height;
            draw();
            resolve();
            track();
          });
          opening = invoke("presentation_open", {
            id,
            sourceId,
            preview,
            events,
          });
          await opening;
          if (surface.closed)
            throw new DOMException(
              "Native surface closed",
              "AbortError",
            );
          refresh = setInterval(() => {
            if (surface.size.width) draw();
            // A live track can outlast its current video element (for example
            // during view changes). Keep its native lease until close(), even
            // when no bound element is polling presentation statistics.
            if (
              !surface.bound &&
              !renewing &&
              performance.now() - surface.statsAt >= 15000
            ) {
              renewing = true;
              void surface
                .stats()
                .catch((error) => {
                  if (!surface.closed) fail(error);
                })
                .finally(() => {
                  renewing = false;
                });
            }
          }, 500);
        },
        close() {
          if (surface.closed) return;
          surface.closed = true;
          reject(
            new DOMException(
              "Native surface closed",
              "AbortError",
            ),
          );
          surface.bound?.();
          clearInterval(refresh);
          sources.delete(placeholder);
          placeholder.stop();
          void (opening ?? Promise.resolve())
            .catch(() => {})
            .then(() =>
              invoke("presentation_close", { id }),
            )
            .catch(console.warn);
        },
        layout(value) {
          layoutTail = layoutTail
            .catch(() => {})
            .then(() =>
              invoke<void>("presentation_layout", {
                id,
                layout: value,
              }),
            );
          return layoutTail;
        },
        async stats() {
          const stats = await invoke<GpuStats>(
            "presentation_stats",
            { id },
          );
          surface.latestStats = stats;
          surface.statsAt = performance.now();
          if (stats.error) throw new Error(stats.error);
          return stats;
        },
      };
      sources.set(placeholder, surface);
      return surface;
    },
    bind(
      track: MediaStreamTrack,
      video: HTMLVideoElement,
      active = true,
    ): (() => void) | undefined {
      const surface = sources.get(track);
      if (!surface || surface.closed) return;
      surface.bound?.();
      const key = Symbol();
      let stopped = false,
        raf = 0,
        last = "",
        sending = false;
      let next:
        | Record<string, number | boolean>
        | undefined;
      let shown = false;
      let nativeVisible = true;
      let unwatch: (() => void) | undefined;
      const lifetime = new AbortController();
      let check: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        try {
          const stats = await surface.stats();
          if (stopped) return;
          shown = stats.presentedFrames > 0;
          check = setTimeout(
            () => void poll(),
            shown ? 1000 : 100,
          );
        } catch (error) {
          if (!stopped) surface.fail(error);
        }
      };
      const send = async () => {
        if (sending || stopped) return;
        sending = true;
        try {
          while (next && !stopped) {
            const value = next;
            next = undefined;
            await surface.layout(value);
          }
        } catch (error) {
          if (!stopped) surface.fail(error);
        } finally {
          sending = false;
        }
      };
      const position = () => {
        if (stopped) return;
        const box = video.getBoundingClientRect();
        const { width, height } = surface.size;
        const scale = Math.min(
          box.width / width,
          box.height / height,
        );
        let radius = 0;
        let left = Math.max(box.left, 0),
          top = Math.max(box.top, 0);
        let right = Math.min(box.right, innerWidth),
          bottom = Math.min(box.bottom, innerHeight);
        let visible =
          active &&
          nativeVisible &&
          !document.hidden &&
          video.isConnected &&
          (!document.fullscreenElement ||
            document.fullscreenElement.contains(video)) &&
          width > 0 &&
          height > 0;
        for (
          let parent: Element | null = video;
          parent;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            Number(style.opacity) === 0
          )
            visible = false;
          if (
            style.overflowX !== "visible" ||
            style.overflowY !== "visible"
          ) {
            const clip = parent.getBoundingClientRect();
            left = Math.max(left, clip.left);
            top = Math.max(top, clip.top);
            right = Math.min(right, clip.right);
            bottom = Math.min(bottom, clip.bottom);
            radius = Math.max(
              radius,
              parseFloat(style.borderTopLeftRadius) || 0,
            );
          }
          // A fullscreen element lives in the top layer and escapes the clips
          // of its original tile ancestors.
          if (parent === document.fullscreenElement) break;
        }
        const rect: SurfaceRect = {
          x: box.x + (box.width - width * scale) / 2,
          y: box.y + (box.height - height * scale) / 2,
          width: width * scale || 0,
          height: height * scale || 0,
          radius,
        };
        visible &&=
          right > left &&
          bottom > top &&
          rect.width > 0 &&
          rect.height > 0;
        surface.visible = visible;
        const ratio = devicePixelRatio;
        const value = {
          x: rect.x * ratio || 0,
          y: rect.y * ratio || 0,
          width: rect.width * ratio,
          height: rect.height * ratio,
          radius: radius * ratio,
          visible,
        };
        const serialized = JSON.stringify(value);
        if (serialized !== last) {
          last = serialized;
          next = value;
          void send();
        }
        if (visible && shown) {
          const x = Math.max(rect.x, left),
            y = Math.max(rect.y, top);
          layout.show(key, video, {
            x,
            y,
            width: Math.max(
              0,
              Math.min(rect.x + rect.width, right) - x,
            ),
            height: Math.max(
              0,
              Math.min(rect.y + rect.height, bottom) - y,
            ),
            radius,
          });
        } else layout.hide(key, video);
        raf = requestAnimationFrame(position);
      };
      const close = () => {
        if (stopped) return;
        stopped = true;
        unwatch?.();
        lifetime.abort();
        cancelAnimationFrame(raf);
        clearTimeout(check);
        layout.hide(key, video);
        if (surface.bound === close) {
          surface.bound = undefined;
          surface.visible = false;
          void surface
            .layout({
              x: 0,
              y: 0,
              width: 0,
              height: 0,
              radius: 0,
              visible: false,
            })
            .catch(() => {});
        }
      };
      surface.bound = close;
      const refreshPosition = () => {
        cancelAnimationFrame(raf);
        position();
      };
      unwatch = watchVisibility?.((visible) => {
        nativeVisible = visible;
        refreshPosition();
      });
      document.addEventListener(
        "visibilitychange",
        refreshPosition,
        { signal: lifetime.signal },
      );
      document.addEventListener(
        "fullscreenchange",
        refreshPosition,
        { signal: lifetime.signal },
      );
      void poll();
      refreshPosition();
      return close;
    },
  };
}
export type NativePresentation = ReturnType<
  typeof createNativePresentation
>;
