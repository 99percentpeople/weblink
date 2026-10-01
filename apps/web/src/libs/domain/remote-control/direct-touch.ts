import {
  MAX_TOUCH_CONTACTS,
  type TouchContact,
  type TouchPhase,
} from "./touch-types";
import type { PointerPosition } from "./pointer";
type Contact = PointerPosition & { id: number };
/** Complete contact frames stay ordered; stationary updates preserve OS press-and-hold gestures. */
export class DirectTouch {
  private contacts = new Map<number, Contact>();
  private dirty = false;
  private moveTimer?: ReturnType<typeof setTimeout>;
  private holdTimer?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private generation = 0;
  constructor(
    private readonly send: (
      contacts: TouchContact[],
    ) => void,
  ) {}
  down(
    pointer: number,
    position: PointerPosition,
  ): boolean {
    if (
      this.contacts.has(pointer) ||
      this.contacts.size >= MAX_TOUCH_CONTACTS
    )
      return false;
    const generation = this.generation;
    this.flush();
    if (generation !== this.generation) return false;
    const used = new Set(
      [...this.contacts.values()].map((c) => c.id),
    );
    let id = 1;
    while (used.has(id)) ++id;
    this.contacts.set(pointer, { ...position, id });
    this.frame(pointer, "down");
    // A send failure can synchronously close the controller and cancel this gesture.
    if (!this.contacts.has(pointer)) return false;
    if (!this.holdTimer)
      this.holdTimer = setInterval(() => {
        if (performance.now() - this.lastFrame >= 45)
          this.frame();
      }, 50);
    return true;
  }
  move(pointer: number, position: PointerPosition) {
    const contact = this.contacts.get(pointer);
    if (
      !contact ||
      (contact.x === position.x && contact.y === position.y)
    )
      return;
    Object.assign(contact, position);
    this.dirty = true;
    if (!this.moveTimer)
      this.moveTimer = setTimeout(
        () => this.flush(),
        1000 / 60,
      );
  }
  up(pointer: number, position?: PointerPosition) {
    if (!this.contacts.has(pointer)) return;
    if (position) this.move(pointer, position);
    this.flush();
    if (!this.contacts.has(pointer)) return;
    this.frame(pointer, "up");
    this.contacts.delete(pointer);
    if (!this.contacts.size) this.clearTimers();
  }
  private flush() {
    clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    if (this.dirty) this.frame();
  }
  private frame(
    pointer?: number,
    phase: TouchPhase = "update",
  ) {
    if (!this.contacts.size) return;
    this.dirty = false;
    this.lastFrame = performance.now();
    this.send(
      [...this.contacts].map(([key, contact]) => ({
        ...contact,
        phase: key === pointer ? phase : "update",
      })),
    );
  }
  private clearTimers() {
    clearTimeout(this.moveTimer);
    clearInterval(this.holdTimer);
    this.moveTimer = this.holdTimer = undefined;
    this.dirty = false;
  }
  cancel() {
    ++this.generation;
    this.clearTimers();
    const contacts: TouchContact[] = [
      ...this.contacts.values(),
    ].map((c) => ({
      ...c,
      phase: "cancel",
    }));
    this.contacts.clear();
    if (contacts.length) this.send(contacts);
  }
}
