import { onCleanup } from "solid-js";
import type { LocalCursorFrame } from "./remote-cursor";
import { cursorGeometry } from "../domain/protocol/remote-control/cursor";

/** Keep the cursor outside clipped video tiles. Movement only changes a local
 * transform; drawing and playback never send pointer messages. */
export function createCursorCanvas(
  document: () => Document | undefined,
) {
  let canvas: HTMLCanvasElement | undefined;
  let frame: LocalCursorFrame | undefined;
  let watchedDocument: Document | undefined;
  let stopDensityWatch = () => {};
  let failureListener: (() => void) | undefined;
  const watchFailure = (listener: () => void) => {
    failureListener = listener;
    return () => {
      if (failureListener === listener)
        failureListener = undefined;
    };
  };
  let position:
    | { clientX: number; clientY: number }
    | undefined;
  const move = (point = position) => {
    position = point;
    if (!canvas || !frame || !point) return;
    const geometry = cursorGeometry(frame.shape);
    canvas.style.transform = `translate(${point.clientX - geometry.hotspotX}px, ${point.clientY - geometry.hotspotY}px)`;
  };
  const draw = (force: boolean): boolean => {
    if (!canvas || !frame) return false;
    const geometry = cursorGeometry(frame.shape);
    const ratio =
      canvas.ownerDocument.defaultView?.devicePixelRatio ??
      1;
    // Browser zoom can make DPR arbitrarily large. Bound backing-store memory,
    // independently of logical size, while covering normal high-density monitors.
    const density =
      Number.isFinite(ratio) && ratio > 0
        ? Math.min(8, ratio)
        : 1;
    const width = Math.max(
      1,
      Math.round(geometry.width * density),
    );
    const height = Math.max(
      1,
      Math.round(geometry.height * density),
    );
    if (
      !force &&
      canvas.width === width &&
      canvas.height === height
    )
      return true;
    try {
      const ctx = canvas.getContext("2d");
      if (!ctx) return false;
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      canvas.style.width = `${geometry.width}px`;
      canvas.style.height = `${geometry.height}px`;
      ctx.clearRect(0, 0, width, height);
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(frame.image, 0, 0, width, height);
      return true;
    } catch {
      return false;
    }
  };
  const stop = () => {
    stopDensityWatch();
    stopDensityWatch = () => {};
    watchedDocument = undefined;
    frame = undefined;
    canvas?.remove();
  };
  const watchDensity = (doc: Document) => {
    if (watchedDocument === doc) return;
    stopDensityWatch();
    watchedDocument = doc;
    const win = doc.defaultView;
    if (!win?.matchMedia) {
      stopDensityWatch = () => {};
      return;
    }
    let active = true;
    let query: MediaQueryList | undefined;
    const observe = () => {
      query?.removeEventListener("change", changed);
      query = win.matchMedia(
        `(resolution: ${win.devicePixelRatio}dppx)`,
      );
      query.addEventListener("change", changed);
    };
    const changed = () => {
      if (!active || !frame) return;
      observe();
      if (!draw(false)) {
        stop();
        failureListener?.();
      }
    };
    observe();
    stopDensityWatch = () => {
      active = false;
      query?.removeEventListener("change", changed);
    };
  };
  const refresh = (): boolean => {
    const doc = document();
    if (!doc || !canvas || !frame) return false;
    const parent = doc.fullscreenElement ?? doc.body;
    if (canvas.parentNode !== parent)
      parent.appendChild(canvas);
    if (!draw(false)) {
      stop();
      failureListener?.();
      return false;
    }
    move();
    return true;
  };
  const paint = (
    next: LocalCursorFrame | undefined,
  ): boolean => {
    frame = next;
    if (!next) {
      stop();
      return true;
    }
    const doc = document();
    if (!doc || !position) {
      stop();
      return false;
    }
    if (!canvas || canvas.ownerDocument !== doc) {
      canvas?.remove();
      canvas = doc.createElement("canvas");
      canvas.setAttribute("aria-hidden", "true");
      Object.assign(canvas.style, {
        position: "fixed",
        left: "0",
        top: "0",
        pointerEvents: "none",
        zIndex: "2147483647",
        margin: "0",
        padding: "0",
        border: "0",
      });
    }
    try {
      if (!draw(true)) {
        stop();
        return false;
      }
      watchDensity(doc);
      return refresh();
    } catch {
      stop();
      return false;
    }
  };
  onCleanup(stop);
  return { paint, move, refresh, watchFailure };
}
