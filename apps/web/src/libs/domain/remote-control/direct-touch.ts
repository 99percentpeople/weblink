import {
  MAX_TOUCH_CONTACTS,
  type TouchContact,
  type TouchPhase,
  type TouchSample,
} from "./touch-types";
import type { PointerPosition } from "./pointer";
import type { TouchSampleRate } from "./touch-options";
type Contact = TouchSample & { id: number };
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
    private readonly sampleRate: TouchSampleRate = 120,
  ) {}
  down(pointer: number, position: TouchSample): boolean {
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
  move(pointer: number, position: TouchSample) {
    const contact = this.contacts.get(pointer);
    if (
      !contact ||
      (contact.x === position.x &&
        contact.y === position.y &&
        contact.pressure === position.pressure &&
        contact.width === position.width &&
        contact.height === position.height)
    )
      return;
    this.contacts.set(pointer, {
      ...position,
      id: contact.id,
    });
    this.dirty = true;
    if (!this.moveTimer)
      this.moveTimer = setTimeout(
        () => this.flush(),
        Math.max(
          0,
          Math.ceil(
            1000 / this.sampleRate -
              (performance.now() - this.lastFrame),
          ),
        ),
      );
  }
  up(pointer: number, position?: PointerPosition) {
    const contact = this.contacts.get(pointer);
    if (!contact) return;
    // Releasing pressure must not become an in-contact update before UP.
    if (position)
      this.move(pointer, {
        ...contact,
        x: position.x,
        y: position.y,
      });
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
        ...(key === pointer &&
        phase === "up" &&
        contact.pressure !== undefined
          ? { pressure: 0 }
          : {}),
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
