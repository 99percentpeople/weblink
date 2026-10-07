import type {
  PointerEvent,
  PointerPosition,
} from "./pointer";
import type { RemoteTouchOptions } from "./touch-options";
import type {
  TrackpadEvent,
  TrackpadPan,
} from "./trackpad-types";
import { TouchGesture } from "./touch-gesture";
export interface TrackpadPort {
  move(position: PointerPosition): void;
  input(event: PointerEvent): void;
  position(): PointerPosition;
  /** Supported hosts resolve gestures at the actual OS cursor, never a cached coordinate. */
  relative?(event: TrackpadEvent): void;
  /** Native two-contact pan/zoom; no emulated wheel fallback. */
  pan?(gesture: TrackpadPan): void;
  /** Size of the displayed video content in CSS pixels. */
  size(): { width: number; height: number };
}
/** Browser-independent gesture state. A two-finger gesture never falls back to a one-finger tap. */
export class Trackpad {
  private gesture = new TouchGesture();
  private tap = false;
  private dragging = false;
  private cursor: PointerPosition = { x: 0.5, y: 0.5 };
  private scrollOrigin?: PointerPosition;
  private scrollPrevious: PointerPosition = { x: 0, y: 0 };
  private pinchOrigin = 0;
  private pinchPrevious = 1;
  private pinching = false;
  private scrolling = false;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly port: TrackpadPort,
    private readonly options: RemoteTouchOptions,
  ) {}
  down(id: number, x: number, y: number): boolean {
    if (this.gesture.has(id)) return false;
    if (this.gesture.size >= 2) {
      this.cancel();
      return false;
    }
    if (!this.gesture.size) {
      this.cursor = { ...this.port.position() };
      this.tap = true;
      this.scrollOrigin = undefined;
      this.scrolling = false;
    }
    this.gesture.down(id, x, y);
    if (this.gesture.size === 2) {
      this.scrollOrigin = this.gesture.center();
      this.scrollPrevious = { x: 0, y: 0 };
      this.pinchOrigin = this.gesture.distance();
      this.pinchPrevious = 1;
      this.pinching = false;
      this.scrolling =
        (this.options.twoFingerScroll ||
          this.options.twoFingerZoom) &&
        !!this.port.pan;
      // End a one-finger drag before the native gesture starts.
      this.release();
      if (this.scrolling)
        this.port.pan?.({ phase: "start" });
    }
    return true;
  }
  /** The browser decides when a stationary touch becomes a long press. */
  contextMenu() {
    if (
      !this.tap ||
      this.gesture.size !== 1 ||
      this.gesture.peak !== 1
    )
      return;
    this.tap = false;
    if (this.options.longPress === "drag") {
      this.dragging = true;
      this.button(0, true);
    } else if (this.options.longPress === "right-click")
      this.click(2);
  }
  move(id: number, x: number, y: number) {
    const delta = this.gesture.move(id, x, y);
    if (!delta) return;
    const { x: dx, y: dy } = delta;
    if (!dx && !dy) return;
    if (this.gesture.movement > 8) {
      this.tap = false;
    }
    if (this.gesture.peak === 1) {
      const { width, height } = this.port.size();
      if (!(width > 0 && height > 0)) return;
      if (this.port.relative) {
        this.port.relative({
          type: "move",
          x: Math.max(
            -1,
            Math.min(
              1,
              (dx / width) * this.options.pointerSpeed,
            ),
          ),
          y: Math.max(
            -1,
            Math.min(
              1,
              (dy / height) * this.options.pointerSpeed,
            ),
          ),
        });
        return;
      }
      const clamp = (v: number) =>
        Math.min(1, Math.max(0, v));
      this.cursor = {
        x: clamp(
          this.cursor.x +
            (dx / width) * this.options.pointerSpeed,
        ),
        y: clamp(
          this.cursor.y +
            (dy / height) * this.options.pointerSpeed,
        ),
      };
      this.port.move(this.cursor);
    } else if (this.gesture.size === 2) {
      // Sample centroid and distance after both pointer events have arrived.
      // Send cumulative positions, so event frequency never changes travel distance.
      if (this.scrolling && !this.scrollTimer)
        this.scrollTimer = setTimeout(
          () => this.flushScroll(),
          Math.ceil(1000 / this.options.sampleRate),
        );
    }
  }
  up(id: number, x: number, y: number) {
    if (!this.gesture.has(id)) return;
    this.move(id, x, y);
    this.flushScroll();
    if (this.scrolling) {
      this.scrolling = false;
      this.port.pan?.({ phase: "end" });
    }
    this.gesture.up(id, x, y);
    if (this.gesture.size) return;
    this.release();
    if (this.tap && this.gesture.isTap(300, 8)) {
      if (
        this.gesture.peak === 2 &&
        this.options.twoFingerRightClick
      )
        this.click(2);
      else if (
        this.gesture.peak === 1 &&
        this.options.tapToClick
      )
        this.click(0);
    }
    this.tap = false;
  }
  private button(button: number, down: boolean) {
    if (this.port.relative) {
      this.port.relative({ type: "button", button, down });
      return;
    }
    this.port.input({
      type: "button",
      ...this.cursor,
      button,
      down,
    });
  }
  private click(button: number) {
    this.button(button, true);
    this.button(button, false);
  }
  private release() {
    const dragging = this.dragging;
    this.dragging = false;
    if (dragging) this.button(0, false);
  }
  cancel() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    const scrolling = this.scrolling;
    this.scrolling = false;
    if (scrolling) this.port.pan?.({ phase: "cancel" });
    this.release();
    this.gesture.clear();
    this.tap = false;
  }
  private flushScroll() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    if (
      !this.scrolling ||
      this.gesture.size !== 2 ||
      !this.scrollOrigin
    )
      return;
    const center = this.gesture.center();
    const scrollScale = this.options.twoFingerScroll
      ? this.options.scrollSpeed *
        (this.options.naturalScroll ? 1 : -1)
      : 0;
    const limit = (v: number) =>
      Math.max(-2048, Math.min(2048, v * scrollScale));
    const x = limit(center.x - this.scrollOrigin.x);
    const y = limit(center.y - this.scrollOrigin.y);
    let scale = 1;
    if (this.options.twoFingerZoom) {
      const distance = this.gesture.distance();
      // Coincident initial contacts cannot define a ratio. Wait for separation.
      if (this.pinchOrigin < 1) this.pinchOrigin = distance;
      if (
        this.pinchOrigin >= 1 &&
        (this.pinching ||
          Math.abs(distance - this.pinchOrigin) > 8)
      ) {
        this.pinching = true;
        this.tap = false;
        scale = Math.max(
          0.1,
          Math.min(4, distance / this.pinchOrigin),
        );
      }
    }
    if (
      x === this.scrollPrevious.x &&
      y === this.scrollPrevious.y &&
      scale === this.pinchPrevious
    )
      return;
    this.scrollPrevious = { x, y };
    this.pinchPrevious = scale;
    this.port.pan?.({
      phase: "update",
      x,
      y,
      ...(this.pinching ? { scale } : {}),
    });
  }
}
