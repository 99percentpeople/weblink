import {
  controlBlocked,
  type ControlOccupancy,
} from "../protocol/capabilities";
import { createUuid } from "../ids";
import type {
  PointerState,
  RemotePointer,
} from "../remote-control/pointer";

export type ScreenControlSignal =
  | { type: "control-request"; id: string }
  | { type: "control-cancel"; id: string }
  | { type: "control-close"; id: string }
  | {
      type: "control-result";
      id: string;
      sourceId?: string;
      closable?: true;
    };

/** Avatar action hands off to the existing screen pointer after consent and publication. */
export class ScreenControlRequest extends EventTarget {
  private available = false;
  private hostStatus: ControlOccupancy | undefined = {
    state: "idle",
  };
  private clientId = "";
  setHostStatus(
    status: ControlOccupancy | undefined,
    clientId: string,
  ): void {
    this.hostStatus = status;
    this.clientId = clientId;
    this.changed();
  }
  private pending?: { id: string; sourceId?: string };
  private timer?: ReturnType<typeof setTimeout>;
  private pointer?: RemotePointer;
  private stopWatching?: () => void;
  private requestedPointer = false;
  private sharing?: {
    id: string;
    sourceId: string;
    pointer?: RemotePointer;
  };
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
          ? controlBlocked(this.hostStatus, this.clientId)
            ? this.hostStatus &&
              this.hostStatus.state !== "unavailable"
              ? "busy"
              : "unavailable"
            : "viewing"
          : "unavailable";
  }
  controls(pointer: RemotePointer | undefined): boolean {
    return (
      !!pointer &&
      this.pointer === pointer &&
      (this.state() === "requesting" ||
        this.state() === "activating" ||
        this.state() === "active")
    );
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  setAvailable(available: boolean) {
    if (!available) {
      this.reset();
      this.sharing = undefined;
    }
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
    if (value.closable)
      this.sharing = {
        id: value.id,
        sourceId: value.sourceId,
      };
  }
  attach(sourceId: string, pointer: RemotePointer) {
    if (
      this.sharing?.sourceId === sourceId &&
      this.sharing.pointer !== pointer
    ) {
      this.sharing.pointer = pointer;
      this.changed();
    }
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
  detach(pointer: RemotePointer, preserve = false) {
    if (this.sharing?.pointer === pointer) {
      if (preserve) this.sharing.pointer = undefined;
      else this.sharing = undefined;
      this.changed();
    }
    if (this.pointer !== pointer) return;
    // The screen ended, but the peer can still accept a fresh avatar request.
    this.reset();
    this.changed();
  }
  cancel() {
    const id = this.pending?.id;
    const pointer = this.pointer;
    this.reset();
    if (id) this.send({ type: "control-cancel", id });
    pointer?.cancel();
    this.changed();
  }
  canClose(pointer: RemotePointer | undefined): boolean {
    const status = this.hostStatus;
    return (
      !!pointer &&
      this.sharing?.pointer === pointer &&
      !(
        status?.state === "controlled" &&
        status.sourceId === this.sharing.sourceId &&
        status.clientId !== this.clientId
      )
    );
  }
  closeScreen(pointer: RemotePointer) {
    if (!this.canClose(pointer)) return;
    const id = this.sharing!.id;
    pointer.cancel();
    this.send({ type: "control-close", id });
    this.reset();
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
