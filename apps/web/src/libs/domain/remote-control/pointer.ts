import { createUuid } from "../ids";
import type { TrackpadEvent } from "./trackpad-types";
import {
  MAX_TOUCH_CONTACTS,
  type TouchContact,
} from "./touch-types";
import {
  controlId,
  controlTarget,
  type ControlTarget,
  type ControlSignal,
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
  | { type: "trackpad"; action: TrackpadEvent }
  | { type: "touch"; contacts: TouchContact[] }
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
  private persistent = false;
  private congested = false;
  private pendingSignals: ControlSignal[] = [];
  private activationPending = false;
  private panAvailable = false;
  supportsTouchpadPan(): boolean {
    return this.panAvailable;
  }
  private relativeAvailable = false;
  supportsRelativePointer(): boolean {
    return this.relativeAvailable;
  }
  private touchAvailable = false;
  private cursor: PointerPosition = { x: 0.5, y: 0.5 };
  supportsTouch(): boolean {
    return this.touchAvailable;
  }
  position(): PointerPosition {
    return { ...this.cursor };
  }
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
  private relativeMotion?: PointerPosition;
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
      return this.active ? "active" : "activating";
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
      () => this.fail(),
      options,
    );
    channel.addEventListener(
      "error",
      () => this.fail(),
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
    if (!movement) {
      channel.bufferedAmountLowThreshold = HIGH_WATER / 4;
      channel.addEventListener(
        "bufferedamountlow",
        () => this.tick(),
        options,
      );
    }
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
    if (channel?.readyState !== "open") {
      this.fail();
      return false;
    }
    if (
      (!movement && this.congested) ||
      channel.bufferedAmount + data.length > HIGH_WATER
    ) {
      if (!movement) this.backpressure();
      return false;
    }
    try {
      channel.send(data);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.name === "OperationError"
      ) {
        if (!movement) this.backpressure();
      } else this.fail();
      return false;
    }
  }
  private backpressure() {
    if (this.congested) return;
    this.congested = true;
    // Do not retain button/touch events: recovery starts with a release barrier.
    this.suspend();
    this.changed();
  }
  private fail() {
    if (this.closing || this.lifetime.signal.aborted)
      return;
    this.close();
    // The media owner can rebuild its transport while keeping the sender's capture.
    this.dispatchEvent(new Event("transporterror"));
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
      this.touchAvailable =
        v.touchContacts === MAX_TOUCH_CONTACTS;
      this.relativeAvailable = v.relativePointer === true;
      this.persistent = v.persistentControl === true;
      this.panAvailable = v.touchpadPan === true;
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
            if (
              !this.send(signal) &&
              !this.lifetime.signal.aborted
            ) {
              if (this.pendingSignals.length >= 32)
                this.fail();
              else this.pendingSignals.push(signal);
            }
          },
          now: () => performance.now(),
          id: () => createUuid(),
          release: () => this.release(),
          suspend: () => this.suspend(),
        },
        this.persistent,
      );
      this.changed();
      return;
    }
    if (
      v.type === "heartbeat" &&
      typeof v.grantId === "string"
    ) {
      this.session?.acknowledge(v.grantId);
      if (
        this.desired &&
        !this.congested &&
        !this.active &&
        !this.activationPending &&
        this.session?.state.type === "granted" &&
        this.session.state.grantId === v.grantId
      )
        this.beginActivation();
    } else if (
      v.type === "state" &&
      this.session?.state.type === "granted" &&
      v.grantId === this.session.state.grantId &&
      v.inputEpoch === this.epoch
    ) {
      this.activationPending = false;
      this.active = this.desired && v.active === true;
      if (this.persistent && !this.active) this.suspend();
    } else {
      const requesting =
        this.session?.state.type === "requesting";
      this.binding &&
        this.session?.receive(this.binding, data);
      if (
        requesting &&
        this.session?.state.type === "granted"
      )
        this.activate();
    }
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
    if (
      this.session?.state.type !== "granted" ||
      this.active ||
      this.activationPending
    )
      return;
    this.desired = true;
    this.beginActivation();
  }
  private beginActivation() {
    if (this.congested) return;
    this.activationPending = true;
    this.epoch = createUuid();
    this.sequence = 0;
    this.moves = 0;
    this.desired = true;
    this.activationDeadline = performance.now() + 1000;
    this.input({ type: "activate" });
    this.changed();
  }
  /** End only the in-progress gesture; approval and control intent remain active. */
  resetInput() {
    if (!this.desired && !this.active) return;
    this.input({ type: "pause" });
    this.suspend();
    this.beginActivation();
    this.changed();
  }
  private release() {
    this.desired = false;
    this.suspend();
  }
  private suspend() {
    this.active = false;
    this.activationPending = false;
    this.epoch = undefined;
    this.latest = undefined;
    this.relativeMotion = undefined;
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
    if (event.type === "touch" && !this.touchAvailable)
      return;
    if (
      event.type === "trackpad" &&
      (!this.relativeAvailable ||
        (event.action.type === "pan" && !this.panAvailable))
    )
      return;
    if (event.type === "touch") {
      // A queued mouse move must not follow a touch down on the new reliable barrier.
      clearTimeout(this.moveTimer);
      this.moveTimer = undefined;
      this.latest = undefined;
      this.relativeMotion = undefined;
    }
    if ("x" in event)
      this.cursor = { x: event.x, y: event.y };
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
    this.cursor = { ...position };
    this.latest = position;
    this.scheduleMove();
  }
  /** Deltas must use the ordered channel: losing one would lose part of the gesture. */
  trackpad(action: TrackpadEvent) {
    if (!this.active || !this.relativeAvailable) return;
    this.latest = undefined;
    if (action.type === "move") {
      const previous = this.relativeMotion ?? {
        x: 0,
        y: 0,
      };
      this.relativeMotion = {
        x: Math.max(-1, Math.min(1, previous.x + action.x)),
        y: Math.max(-1, Math.min(1, previous.y + action.y)),
      };
      this.scheduleMove();
    } else {
      // A tap/drag/wheel must follow all earlier relative movement.
      this.flushMove();
      this.input({ type: "trackpad", action });
    }
  }
  private flushMove() {
    clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    const relative = this.relativeMotion,
      p = this.latest;
    this.relativeMotion = this.latest = undefined;
    if (relative || p) this.lastMove = performance.now();
    if (relative && (relative.x || relative.y))
      this.input({
        type: "trackpad",
        action: { type: "move", ...relative },
      });
    else if (p) this.input({ type: "move", ...p });
  }
  private scheduleMove() {
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(
      () => this.flushMove(),
      Math.max(
        0,
        1000 / 120 - (performance.now() - this.lastMove),
      ),
    );
  }
  private tick() {
    if (this.lifetime.signal.aborted) return;
    if (this.congested) {
      if (
        !this.reliable ||
        this.reliable.bufferedAmount > HIGH_WATER / 4
      )
        return;
      this.congested = false;
      this.lastHeartbeat = -Infinity;
      while (this.pendingSignals.length) {
        const signal = this.pendingSignals.shift()!;
        if (
          !this.send(signal) &&
          !this.lifetime.signal.aborted
        )
          this.pendingSignals.unshift(signal);
        if (this.congested || this.lifetime.signal.aborted)
          return;
      }
    }
    const before = this.state();
    if (
      this.desired &&
      this.activationPending &&
      !this.active &&
      performance.now() >= this.activationDeadline
    ) {
      if (this.persistent) this.suspend();
      else this.cancel();
    }
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
    this.pendingSignals = [];
    clearInterval(this.timer);
    this.reliable?.close();
    this.movement?.close();
    this.changed();
  }
}
