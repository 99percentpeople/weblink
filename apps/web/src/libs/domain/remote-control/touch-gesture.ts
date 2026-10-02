interface Finger {
  x: number;
  y: number;
  startX: number;
  startY: number;
}

/** Shared contact, movement and timing detection for local touch gestures. */
export class TouchGesture {
  private fingers = new Map<number, Finger>();
  private started = 0;
  count = 0;
  peak = 0;
  movement = 0;

  get size(): number {
    return this.fingers.size;
  }

  has(id: number): boolean {
    return this.fingers.has(id);
  }

  down(id: number, x: number, y: number): boolean {
    if (this.fingers.has(id)) return false;
    if (!this.fingers.size) {
      this.clear();
      this.started = performance.now();
    }
    this.fingers.set(id, { x, y, startX: x, startY: y });
    ++this.count;
    this.peak = Math.max(this.peak, this.fingers.size);
    return true;
  }

  move(
    id: number,
    x: number,
    y: number,
  ): { x: number; y: number } | undefined {
    const finger = this.fingers.get(id);
    if (!finger) return;
    const delta = { x: x - finger.x, y: y - finger.y };
    finger.x = x;
    finger.y = y;
    this.movement = Math.max(
      this.movement,
      Math.hypot(x - finger.startX, y - finger.startY),
    );
    return delta;
  }

  up(id: number, x: number, y: number): boolean {
    if (!this.fingers.has(id)) return false;
    this.move(id, x, y);
    this.fingers.delete(id);
    return true;
  }

  isTap(duration: number, movement: number): boolean {
    return (
      this.count > 0 &&
      performance.now() - this.started <= duration &&
      this.movement <= movement
    );
  }

  center(): { x: number; y: number } {
    let x = 0,
      y = 0;
    for (const finger of this.fingers.values()) {
      x += finger.x;
      y += finger.y;
    }
    return this.size
      ? { x: x / this.size, y: y / this.size }
      : { x: 0, y: 0 };
  }

  clear() {
    this.fingers.clear();
    this.count = this.peak = this.movement = 0;
  }
}
