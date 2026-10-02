import { TouchGesture } from "./touch-gesture";

/** Reserve a local shortcut until the three-finger sequence ends or is cancelled. */
export class ThreeFingerTap {
  private gesture = new TouchGesture();
  consumed = false;

  down(id: number, x: number, y: number) {
    this.gesture.down(id, x, y);
    if (this.gesture.size === 3) this.consumed = true;
  }

  move(id: number, x: number, y: number) {
    // Three fingertips settle independently; allow small contact-centroid drift.
    this.gesture.move(id, x, y);
  }

  up(id: number, x: number, y: number): boolean {
    if (!this.gesture.up(id, x, y) || this.gesture.size)
      return false;
    return this.finish();
  }

  /** Native touchcancel may replace release even after a valid three-finger tap. */
  finish(): boolean {
    const activate =
      this.consumed &&
      this.gesture.count === 3 &&
      this.gesture.isTap(600, 20);
    this.cancel();
    return activate;
  }

  cancel() {
    this.gesture.clear();
    this.consumed = false;
  }
}
