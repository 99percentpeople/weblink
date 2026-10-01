import { createUuid } from "../ids";
import type {
  PointerState,
  RemotePointer,
} from "../remote-control/pointer";

export type ScreenControlSignal =
  | { type: "control-request"; id: string }
  | { type: "control-cancel"; id: string }
  | {
      type: "control-result";
      id: string;
      sourceId?: string;
    };

/** Avatar action hands off to the existing screen pointer after consent and publication. */
export class ScreenControlRequest extends EventTarget {
  private available = false;
  private pending?: { id: string; sourceId?: string };
  private timer?: ReturnType<typeof setTimeout>;
  private pointer?: RemotePointer;
  private stopWatching?: () => void;
  private requestedPointer = false;
  constructor(
    private readonly send: (
      value: ScreenControlSignal,
    ) => void,
  ) {
    super();
  }
  state(): PointerState {
    return this.pointer && this.requestedPointer
      ? this.pointer.state()
      : this.pending
        ? "requesting"
        : this.available
          ? "viewing"
          : "unavailable";
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  setAvailable(available: boolean) {
    if (!available) this.reset();
    this.available = available;
    this.changed();
  }
  request() {
    if (this.state() !== "viewing") return;
    if (this.pointer && this.requestedPointer) {
      this.pointer.request();
      return;
    }
    const id = createUuid();
    this.pending = { id };
    this.timer = setTimeout(() => this.cancel(), 60_000);
    try {
      this.send({ type: "control-request", id });
    } catch {
      this.reset();
    }
    this.changed();
  }
  result(
    value: Extract<
      ScreenControlSignal,
      { type: "control-result" }
    >,
  ) {
    if (this.pending?.id !== value.id) return;
    if (!value.sourceId) {
      this.reset();
      this.changed();
      return;
    }
    this.pending.sourceId = value.sourceId;
  }
  attach(sourceId: string, pointer: RemotePointer) {
    if (
      this.pending?.sourceId !== sourceId ||
      this.pointer === pointer
    )
      return;
    this.stopWatching?.();
    this.pointer = pointer;
    this.requestedPointer = false;
    const changed = () => {
      if (
        !this.requestedPointer &&
        this.pending &&
        pointer.state() === "viewing"
      ) {
        this.requestedPointer = true;
        clearTimeout(this.timer);
        this.pending = undefined;
        pointer.request();
      }
      this.changed();
    };
    pointer.addEventListener("change", changed);
    this.stopWatching = () =>
      pointer.removeEventListener("change", changed);
    changed();
  }
  cancel() {
    const id = this.pending?.id;
    const pointer = this.pointer;
    this.reset();
    if (id) this.send({ type: "control-cancel", id });
    pointer?.cancel();
    this.changed();
  }
  reset() {
    clearTimeout(this.timer);
    this.stopWatching?.();
    this.stopWatching = undefined;
    this.pointer = undefined;
    this.requestedPointer = false;
    this.pending = undefined;
  }
}
