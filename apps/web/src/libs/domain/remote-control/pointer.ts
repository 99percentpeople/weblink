import { createUuid } from "../ids";
import {
  controlId,
  controlTarget,
  type ControlTarget,
} from "../protocol/remote-control";
import {
  RemoteControlSession,
  type ControlBinding,
} from "./session";
export const CONTROL_CHANNEL = "weblink-control";
export const POINTER_CHANNEL = "weblink-pointer";
const HIGH_WATER = 16 * 1024;
export type PointerPosition = { x: number; y: number };
export type PointerEvent =
  | { type: "activate" | "pause" }
  | ({ type: "move" } & PointerPosition)
  | ({
      type: "button";
      button: number;
      down: boolean;
    } & PointerPosition)
  | ({
      type: "wheel";
      horizontal: number;
      vertical: number;
    } & PointerPosition);
export type PointerState =
  | "unavailable"
  | "viewing"
  | "requesting"
  | "paused"
  | "activating"
  | "active";
/** Only absolute coordinates inside the displayed video content; letterboxing is not interactive. */
export function videoPosition(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  width: number,
  height: number,
  x: number,
  y: number,
): PointerPosition | undefined {
  if (
    ![
      rect.left,
      rect.top,
      rect.width,
      rect.height,
      width,
      height,
      x,
      y,
    ].every(Number.isFinite) ||
    Math.min(rect.width, rect.height, width, height) <= 0
  )
    return;
  const scale = Math.min(
    rect.width / width,
    rect.height / height,
  );
  const w = width * scale,
    h = height * scale;
  const px = (x - rect.left - (rect.width - w) / 2) / w,
    py = (y - rect.top - (rect.height - h) / 2) / h;
  if (px < 0 || py < 0 || px > 1 || py > 1) return;
  return { x: px, y: py };
}
export class RemotePointer extends EventTarget {
  private reliable?: RTCDataChannel;
  private movement?: RTCDataChannel;
  private readonly lifetime = new AbortController();
  private binding?: ControlBinding;
  private session?: RemoteControlSession;
  private target?: ControlTarget;
  private generation?: string;
  private epoch?: string;
  private sequence = 0;
  private moves = 0;
  private activationDeadline = 0;
  private desired = false;
  private active = false;
  private closing = false;
  private latest?: PointerPosition;
  private moveTimer?: ReturnType<typeof setTimeout>;
  private lastMove = 0;
  private lastHeartbeat = 0;
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly sourceId: string,
    private readonly mediaId: string,
  ) {
    super();
  }
  state(): PointerState {
    if (
      this.lifetime.signal.aborted ||
      !this.session ||
      this.reliable?.readyState !== "open" ||
      this.movement?.readyState !== "open"
    )
      return "unavailable";
    const s = this.session.state;
    if (s.type === "closed") return "unavailable";
    if (s.type === "granted")
      return this.active
        ? "active"
        : this.desired
          ? "activating"
          : "paused";
    return s.type;
  }
  bind(channel: RTCDataChannel) {
    const movement = channel.label === POINTER_CHANNEL;
    if (
      this.lifetime.signal.aborted ||
      channel.protocol !== channel.label ||
      (!movement && channel.label !== CONTROL_CHANNEL) ||
      (movement
        ? channel.ordered ||
          channel.maxRetransmits !== 0 ||
          !!this.movement
        : !channel.ordered ||
          channel.maxRetransmits !== null ||
          channel.maxPacketLifeTime !== null ||
          !!this.reliable)
    ) {
      channel.close();
      return;
    }
    if (movement) this.movement = channel;
    else this.reliable = channel;
    const options = { signal: this.lifetime.signal };
    channel.addEventListener(
      "close",
      () => this.close(),
      options,
    );
    channel.addEventListener(
      "error",
      () => this.close(),
      options,
    );
    channel.addEventListener(
      "open",
      () => this.changed(),
      options,
    );
    if (!movement)
      channel.addEventListener(
        "message",
        (e) => this.receive(e.data),
        options,
      );
    if (!this.timer)
      this.timer = setInterval(() => this.tick(), 100);
  }
  private changed() {
    this.dispatchEvent(new Event("change"));
  }
  private send(value: unknown, movement = false): boolean {
    const channel = movement
      ? this.movement
      : this.reliable;
    const data = JSON.stringify(value);
    if (
      channel?.readyState !== "open" ||
      channel.bufferedAmount + data.length > HIGH_WATER
    ) {
      if (!movement) this.close();
      return false;
    }
    try {
      channel.send(data);
      return true;
    } catch {
      this.close();
      return false;
    }
  }
  private receive(data: unknown) {
    if (
      typeof data !== "string" ||
      data.length > 4096 ||
      new TextEncoder().encode(data).length > 4096
    )
      return;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(data);
      if (!v || typeof v !== "object") return;
    } catch {
      return;
    }
    if (v.type === "ready") {
      if (
        this.session ||
        !controlTarget(v.target) ||
        v.target.sourceId !== this.sourceId ||
        v.target.mediaId !== this.mediaId ||
        !controlId(v.generation) ||
        v.generation !== this.mediaId
      )
        return;
      this.target = { ...v.target };
      this.generation = v.generation;
      this.binding = {
        roomGeneration: this.generation,
        peerGeneration: this.generation,
        clientId: this.generation,
        target: this.target,
      };
      this.session = new RemoteControlSession(
        this.binding,
        {
          send: (signal) => {
            this.send(signal);
          },
          now: () => performance.now(),
          id: () => createUuid(),
          release: () => this.release(),
        },
      );
      this.changed();
      return;
    }
    if (
      v.type === "heartbeat" &&
      typeof v.grantId === "string"
    )
      this.session?.acknowledge(v.grantId);
    else if (
      v.type === "state" &&
      this.session?.state.type === "granted" &&
      v.grantId === this.session.state.grantId &&
      v.inputEpoch === this.epoch
    ) {
      this.active = this.desired && v.active === true;
    } else
      this.binding &&
        this.session?.receive(this.binding, data);
    this.changed();
  }
  request() {
    if (this.state() === "viewing")
      this.session?.request(
        { request: true, host: false },
        { request: true, host: true },
      );
    this.changed();
  }
  cancel() {
    this.session?.cancel();
    this.release();
    this.changed();
  }
  activate() {
    if (this.state() !== "paused") return;
    this.epoch = createUuid();
    this.sequence = 0;
    this.moves = 0;
    this.desired = true;
    this.activationDeadline = performance.now() + 1000;
    this.input({ type: "activate" });
    this.changed();
  }
  pause() {
    if (this.desired || this.active)
      this.input({ type: "pause" });
    this.release();
    this.changed();
  }
  private release() {
    this.active = false;
    this.desired = false;
    this.latest = undefined;
    clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
  }
  input(event: PointerEvent) {
    const state = this.session?.state;
    if (
      state?.type !== "granted" ||
      !this.epoch ||
      (!this.active &&
        event.type !== "activate" &&
        event.type !== "pause")
    )
      return;
    const movement = event.type === "move";
    this.send(
      {
        type: "input",
        grantId: state.grantId,
        generation: this.generation,
        geometryRevision: this.target!.geometryRevision,
        inputEpoch: this.epoch,
        sequence: movement ? ++this.moves : ++this.sequence,
        after: movement ? this.sequence : 0,
        event,
      },
      movement,
    );
  }
  move(position: PointerPosition) {
    if (!this.active) return;
    this.latest = position;
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(
      () => {
        this.moveTimer = undefined;
        const p = this.latest;
        this.latest = undefined;
        if (p) {
          this.lastMove = performance.now();
          this.input({ type: "move", ...p });
        }
      },
      Math.max(
        0,
        1000 / 120 - (performance.now() - this.lastMove),
      ),
    );
  }
  private tick() {
    const before = this.state();
    if (
      this.desired &&
      !this.active &&
      performance.now() >= this.activationDeadline
    )
      this.cancel();
    this.session?.tick();
    const state = this.session?.state;
    if (
      state?.type === "granted" &&
      performance.now() - this.lastHeartbeat >= 500
    ) {
      this.lastHeartbeat = performance.now();
      this.send({
        type: "heartbeat",
        grantId: state.grantId,
        generation: this.generation,
        geometryRevision: this.target!.geometryRevision,
      });
    }
    if (before !== this.state()) this.changed();
  }
  close() {
    if (this.closing || this.lifetime.signal.aborted)
      return;
    this.closing = true;
    this.session?.close();
    this.release();
    this.lifetime.abort();
    clearInterval(this.timer);
    this.reliable?.close();
    this.movement?.close();
    this.changed();
  }
}
