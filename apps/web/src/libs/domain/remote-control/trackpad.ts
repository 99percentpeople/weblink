import type {
  PointerEvent,
  PointerPosition,
} from "./pointer";
import type { RemoteTouchOptions } from "./touch-options";
import type {
  TrackpadEvent,
  TrackpadPan,
} from "./trackpad-types";
type Finger = {
  x: number;
  y: number;
  startX: number;
  startY: number;
};
export interface TrackpadPort {
  move(position: PointerPosition): void;
  input(event: PointerEvent): void;
  position(): PointerPosition;
  /** Supported hosts resolve gestures at the actual OS cursor, never a cached coordinate. */
  relative?(event: TrackpadEvent): void;
  /** Native two-contact pan; no emulated wheel fallback. */
  pan?(gesture: TrackpadPan): void;
  /** Size of the displayed video content in CSS pixels. */
  size(): { width: number; height: number };
}
/** Browser-independent gesture state. A two-finger gesture never falls back to a one-finger tap. */
export class Trackpad {
  private fingers = new Map<number, Finger>();
  private started = 0;
  private peak = 0;
  private tap = false;
  private dragging = false;
  private cursor: PointerPosition = { x: 0.5, y: 0.5 };
  private scrollOrigin?: PointerPosition;
  private scrollPrevious: PointerPosition = { x: 0, y: 0 };
  private scrolling = false;
  private scrollTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly port: TrackpadPort,
    private readonly options: RemoteTouchOptions,
  ) {}
  down(id: number, x: number, y: number): boolean {
    if (this.fingers.has(id)) return false;
    if (this.fingers.size >= 2) {
      this.cancel();
      return false;
    }
    if (!this.fingers.size) {
      this.cursor = { ...this.port.position() };
      this.started = performance.now();
      this.tap = true;
      this.peak = 0;
      this.scrollOrigin = undefined;
      this.scrolling = false;
    }
    this.fingers.set(id, { x, y, startX: x, startY: y });
    this.peak = Math.max(this.peak, this.fingers.size);
    if (this.fingers.size === 2) {
      this.scrollOrigin = this.center();
      this.scrollPrevious = { x: 0, y: 0 };
      this.scrolling =
        this.options.twoFingerScroll && !!this.port.pan;
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
      this.fingers.size !== 1 ||
      this.peak !== 1
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
    const finger = this.fingers.get(id);
    if (!finger) return;
    const dx = x - finger.x,
      dy = y - finger.y;
    finger.x = x;
    finger.y = y;
    if (
      Math.hypot(x - finger.startX, y - finger.startY) > 8
    ) {
      this.tap = false;
    }
    if (this.peak === 1) {
      const { width, height } = this.port.size();
      if (!(width > 0 && height > 0)) return;
      if (this.port.relative) {
        if (dx || dy)
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
    } else if (
      this.fingers.size === 2 &&
      this.options.twoFingerScroll
    ) {
      // Sample the latest centroid after both pointer events have arrived.
      // Send cumulative positions, so event frequency never changes travel distance.
      if (this.scrolling && !this.scrollTimer)
        this.scrollTimer = setTimeout(
          () => this.flushScroll(),
          1000 / 120,
        );
    }
  }
  up(id: number, x: number, y: number) {
    if (!this.fingers.has(id)) return;
    this.move(id, x, y);
    this.flushScroll();
    if (this.scrolling) {
      this.scrolling = false;
      this.port.pan?.({ phase: "end" });
    }
    this.fingers.delete(id);
    if (this.fingers.size) return;
    this.release();
    if (
      this.tap &&
      performance.now() - this.started <= 300
    ) {
      if (
        this.peak === 2 &&
        this.options.twoFingerRightClick
      )
        this.click(2);
      else if (this.peak === 1 && this.options.tapToClick)
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
    this.fingers.clear();
    this.tap = false;
  }
  private center(): PointerPosition {
    const fingers = [...this.fingers.values()];
    return {
      x: (fingers[0].x + fingers[1].x) / 2,
      y: (fingers[0].y + fingers[1].y) / 2,
    };
  }
  private flushScroll() {
    clearTimeout(this.scrollTimer);
    this.scrollTimer = undefined;
    if (
      !this.scrolling ||
      this.fingers.size !== 2 ||
      !this.scrollOrigin
    )
      return;
    const center = this.center();
    const scale =
      this.options.scrollSpeed *
      (this.options.naturalScroll ? 1 : -1);
    const limit = (v: number) =>
      Math.max(-2048, Math.min(2048, v * scale));
    const x = limit(center.x - this.scrollOrigin.x);
    const y = limit(center.y - this.scrollOrigin.y);
    if (
      x === this.scrollPrevious.x &&
      y === this.scrollPrevious.y
    )
      return;
    this.scrollPrevious = { x, y };
    this.port.pan?.({ phase: "update", x, y });
  }
}
