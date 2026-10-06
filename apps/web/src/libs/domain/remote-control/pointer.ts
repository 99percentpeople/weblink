import { createUuid } from "../ids";
import {
  MAX_CURSOR_MESSAGE_BYTES,
  parseRemoteCursorShape,
  type RemoteCursorShape,
} from "../protocol/remote-control/cursor";
import type { TrackpadEvent } from "./trackpad-types";
import type { TouchSampleRate } from "./touch-options";
import type { RemoteKeyEvent } from "./keyboard";
import {
  parseTextInputFocus,
  type TextInputFocus,
} from "./auto-keyboard";
import {
  validRemoteText,
  type RemoteTextEvent,
} from "./text";
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
  | RemoteKeyEvent
  | RemoteTextEvent
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
/** Start inside the video; captured touches can continue at its nearest edge. */
export function videoPosition(
  rect: Pick<DOMRect, "left" | "top" | "width" | "height">,
  width: number,
  height: number,
  x: number,
  y: number,
  clamp = false,
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
  if (clamp)
    return {
      x: Math.max(0, Math.min(1, px)),
      y: Math.max(0, Math.min(1, py)),
    };
  if (px < 0 || py < 0 || px > 1 || py > 1) return;
  return { x: px, y: py };
}
export class RemotePointer extends EventTarget {
  private fileDropAvailable = false;
  fileDropTarget():
    | { grantId: string; target: ControlTarget }
    | undefined {
    const grantId = this.clipboardGrant();
    if (this.fileDropAvailable && grantId && this.target)
      return { grantId, target: { ...this.target } };
  }
  clipboardGrant(): string | undefined {
    const s = this.session?.state;
    return s?.type === "granted" &&
      ["active", "activating"].includes(this.state())
      ? s.grantId
      : undefined;
  }
  clipboardEpoch(): string | undefined {
    return this.epoch;
  }
  private cursorVisibilityAvailable = false;
  private cursorVisible = true;
  /** The host owns cursor composition; old hosts keep their existing behavior. */
  setCursorVisible(visible: boolean): void {
    const state = this.session?.state;
    if (
      !this.cursorVisibilityAvailable ||
      !this.active ||
      state?.type !== "granted" ||
      this.cursorVisible === visible
    )
      return;
    if (
      this.send({
        type: "cursor",
        grantId: state.grantId,
        generation: this.generation,
        geometryRevision: this.target!.geometryRevision,
        inputEpoch: this.epoch,
        visible,
      })
    )
      this.cursorVisible = visible;
  }
  private cursorShapeAvailable = false;
  private cursorListeners = new Set<
    (shape: RemoteCursorShape | undefined) => void
  >();
  private cursorWatch?: {
    id: string;
    sequence: number;
    latest?: RemoteCursorShape;
  };
  watchCursor(
    listener: (
      shape: RemoteCursorShape | undefined,
    ) => void,
  ): () => void {
    this.cursorListeners.add(listener);
    this.syncCursorWatch();
    listener(this.cursorWatch?.latest);
    return () => {
      this.cursorListeners.delete(listener);
      this.syncCursorWatch();
    };
  }
  private syncCursorWatch(): void {
    const state = this.session?.state;
    if (
      !this.active ||
      state?.type !== "granted" ||
      !this.cursorShapeAvailable
    )
      return;
    if (!this.cursorListeners.size) {
      if (this.cursorWatch) {
        this.cursorWatch = undefined;
        this.send({
          type: "cursor-watch",
          grantId: state.grantId,
          inputEpoch: this.epoch,
          watchId: null,
        });
      }
      return;
    }
    if (this.cursorWatch) return;
    const id = createUuid();
    this.cursorWatch = { id, sequence: 0 };
    if (
      !this.send({
        type: "cursor-watch",
        grantId: state.grantId,
        inputEpoch: this.epoch,
        watchId: id,
      })
    )
      this.cursorWatch = undefined;
  }
  private textAvailable = false;
  private textInputListeners = new Set<
    (focus: TextInputFocus) => void
  >();
  private textInputWatch?: {
    id: string;
    sequence: number;
    latest?: TextInputFocus;
  };
  watchTextInput(
    listener: (focus: TextInputFocus) => void,
  ): () => void {
    this.textInputListeners.add(listener);
    this.syncTextInputWatch();
    const latest = this.textInputWatch?.latest;
    if (latest) listener(latest);
    return () => {
      this.textInputListeners.delete(listener);
      this.syncTextInputWatch();
    };
  }
  /** A tap asks for a fresh stream snapshot after the ordered native input. */
  refreshTextInput(): void {
    this.textInputWatch = undefined;
    this.syncTextInputWatch();
  }
  private syncTextInputWatch(): void {
    const state = this.session?.state;
    if (
      !this.active ||
      state?.type !== "granted" ||
      !this.textAvailable
    )
      return;
    if (!this.textInputListeners.size) {
      if (this.textInputWatch) {
        this.textInputWatch = undefined;
        this.send({
          type: "text-input-watch",
          grantId: state.grantId,
          inputEpoch: this.epoch,
          watchId: null,
        });
      }
      return;
    }
    if (this.textInputWatch) return;
    const id = createUuid();
    this.textInputWatch = { id, sequence: 0 };
    if (
      !this.send({
        type: "text-input-watch",
        watchId: id,
        grantId: state.grantId,
        inputEpoch: this.epoch,
      })
    )
      this.textInputWatch = undefined;
  }
  supportsText(): boolean {
    return this.textAvailable;
  }
  private keyboardAvailable = false;
  supportsKeyboard(): boolean {
    return this.keyboardAvailable;
  }
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
  private activationSequence = 0;
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
      data.length > MAX_CURSOR_MESSAGE_BYTES ||
      new TextEncoder().encode(data).length >
        MAX_CURSOR_MESSAGE_BYTES
    )
      return;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(data);
      if (!v || typeof v !== "object") return;
    } catch {
      return;
    }
    if (
      v.type !== "cursor-state" &&
      new TextEncoder().encode(data).length > 4096
    )
      return;
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
      this.keyboardAvailable = v.keyboard === true;
      this.fileDropAvailable = v.fileDrop === true;
      this.textAvailable =
        this.keyboardAvailable && v.textInput === true;
      this.touchAvailable =
        v.touchContacts === MAX_TOUCH_CONTACTS;
      this.relativeAvailable = v.relativePointer === true;
      this.cursorVisibilityAvailable =
        v.cursorVisibility === true;
      this.cursorShapeAvailable =
        this.cursorVisibilityAvailable &&
        v.cursorShape === true;
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
    if (v.type === "cursor-state") {
      const watch = this.cursorWatch;
      if (
        this.active &&
        this.session?.state.type === "granted" &&
        v.grantId === this.session.state.grantId &&
        v.inputEpoch === this.epoch &&
        watch &&
        v.watchId === watch.id &&
        typeof v.sequence === "number" &&
        Number.isSafeInteger(v.sequence) &&
        v.sequence > watch.sequence
      ) {
        const shape = parseRemoteCursorShape(v.shape);
        if (shape) {
          watch.sequence = v.sequence;
          watch.latest = shape;
          for (const listener of [
            ...this.cursorListeners,
          ]) {
            if (watch !== this.cursorWatch) break;
            listener(shape);
          }
        }
      }
      return;
    }
    if (v.type === "text-input-state") {
      const watch = this.textInputWatch;
      const focus = parseTextInputFocus(v.focus);
      if (
        this.active &&
        this.session?.state.type === "granted" &&
        v.grantId === this.session.state.grantId &&
        v.inputEpoch === this.epoch &&
        watch &&
        v.watchId === watch.id &&
        focus &&
        typeof v.sequence === "number" &&
        Number.isSafeInteger(v.sequence) &&
        v.sequence > watch.sequence
      ) {
        watch.sequence = v.sequence;
        watch.latest = focus;
        for (const listener of [
          ...this.textInputListeners,
        ]) {
          if (watch !== this.textInputWatch) break;
          listener(focus);
        }
      }
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
      this.syncTextInputWatch();
      this.syncCursorWatch();
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
    ++this.activationSequence;
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
    this.textInputWatch = undefined;
    this.cursorWatch = undefined;
    this.cursorVisible = true;
    this.active = false;
    this.activationPending = false;
    this.epoch = undefined;
    this.latest = undefined;
    this.relativeMotion = undefined;
    clearTimeout(this.moveTimer);
    this.moveTimer = undefined;
    for (const listener of [...this.cursorListeners])
      listener(undefined);
  }
  input(event: PointerEvent): boolean {
    const state = this.session?.state;
    if (
      state?.type !== "granted" ||
      !this.epoch ||
      (!this.active &&
        event.type !== "activate" &&
        event.type !== "pause")
    )
      return false;
    if (event.type === "key" && !this.keyboardAvailable)
      return false;
    if (
      event.type === "text" &&
      (!this.textAvailable || !validRemoteText(event.text))
    )
      return false;
    if (event.type === "touch" && !this.touchAvailable)
      return false;
    if (
      event.type === "trackpad" &&
      (!this.relativeAvailable ||
        (event.action.type === "pan" && !this.panAvailable))
    )
      return false;
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
    return this.send(
      {
        type: "input",
        grantId: state.grantId,
        generation: this.generation,
        geometryRevision: this.target!.geometryRevision,
        inputEpoch: this.epoch,
        activationSequence: this.activationSequence,
        sequence: movement ? ++this.moves : ++this.sequence,
        after: movement ? this.sequence : 0,
        event,
      },
      movement,
    );
  }
  move(
    position: PointerPosition,
    sampleRate: TouchSampleRate = 120,
  ) {
    if (!this.active) return;
    this.cursor = { ...position };
    this.latest = position;
    this.scheduleMove(sampleRate);
  }
  /** Deltas must use the ordered channel: losing one would lose part of the gesture. */
  trackpad(
    action: TrackpadEvent,
    sampleRate: TouchSampleRate = 120,
  ) {
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
      this.scheduleMove(sampleRate);
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
  private scheduleMove(sampleRate: TouchSampleRate) {
    const remaining =
      1000 / sampleRate -
      (performance.now() - this.lastMove);
    // A fresh event after the sampling deadline is already admissible.
    // A zero-delay timer needlessly defers it behind other main-thread work.
    if (remaining <= 0) {
      this.flushMove();
      return;
    }
    if (this.moveTimer) return;
    this.moveTimer = setTimeout(
      () => this.flushMove(),
      Math.ceil(remaining),
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
    this.syncTextInputWatch();
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
