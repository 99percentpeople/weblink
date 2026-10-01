import {
  CONTROL_REQUEST_TIMEOUT_MS,
  canRequestControl,
  controlId,
  controlTarget,
  parseControlSignal,
  sameControlTarget,
  type ControlCapabilities,
  type ControlSignal,
  type ControlTarget,
} from "../protocol/remote-control";

/** Supplied by the owning room/PeerSession, never by a network message. */
export interface ControlBinding {
  roomGeneration: string;
  peerGeneration: string;
  clientId: string;
  target: ControlTarget;
}
export type ControlState =
  | { type: "viewing" }
  | {
      type: "requesting";
      requestId: string;
      deadline: number;
    }
  | { type: "granted"; grantId: string; deadline: number }
  | { type: "closed" };
export interface ControlSessionPort {
  send(signal: ControlSignal): void;
  now(): number;
  id(): string;
  /** Clear local held-input bookkeeping before reporting a lost grant. */
  release(): void;
}

/** Controller-side intent only. Native authority must independently validate every input.
 * One instance belongs to one exact room/peer/source/media generation, with no rebind. */
export class RemoteControlSession {
  private current: ControlState = { type: "viewing" };
  private readonly binding: ControlBinding;
  private readonly issued = new Set<string>();
  constructor(
    binding: ControlBinding,
    private readonly port: ControlSessionPort,
  ) {
    if (
      ![
        binding.roomGeneration,
        binding.peerGeneration,
        binding.clientId,
      ].every(controlId) ||
      !controlTarget(binding.target)
    )
      throw new Error("Invalid control session binding");
    this.binding = {
      ...binding,
      target: { ...binding.target },
    };
  }
  get state(): ControlState {
    return { ...this.current };
  }
  request(
    local: ControlCapabilities,
    remote?: ControlCapabilities,
  ): boolean {
    this.tick();
    if (
      this.current.type !== "viewing" ||
      !canRequestControl(local, remote)
    )
      return false;
    const requestId = this.port.id();
    if (
      !controlId(requestId) ||
      this.issued.has(requestId) ||
      this.issued.size >= 256
    )
      return false;
    this.issued.add(requestId);
    this.current = {
      type: "requesting",
      requestId,
      deadline:
        this.port.now() + CONTROL_REQUEST_TIMEOUT_MS,
    };
    return this.send({
      type: "request",
      requestId,
      target: { ...this.binding.target },
    });
  }
  /** The application routes only the channel owned by this binding to this method. */
  receive(binding: ControlBinding, data: unknown): void {
    this.tick();
    if (
      !this.matches(binding) ||
      this.current.type === "closed"
    )
      return;
    const message = parseControlSignal(data);
    if (!message) return;
    if (
      message.type === "grant" &&
      this.current.type === "requesting" &&
      message.requestId === this.current.requestId &&
      sameControlTarget(message.target, this.binding.target)
    ) {
      this.current = {
        type: "granted",
        grantId: message.grantId,
        deadline: this.port.now() + message.leaseMs,
      };
    } else if (
      message.type === "deny" &&
      this.current.type === "requesting" &&
      message.requestId === this.current.requestId
    ) {
      this.current = { type: "viewing" };
    } else if (
      message.type === "revoke" &&
      this.current.type === "granted" &&
      message.grantId === this.current.grantId
    ) {
      this.endGrant();
    }
  }
  cancel(): void {
    const previous = this.current;
    if (previous.type === "closed") return;
    this.endGrant();
    if (previous.type === "requesting")
      this.send({
        type: "cancel",
        requestId: previous.requestId,
      });
    if (previous.type === "granted")
      this.send({
        type: "revoke",
        grantId: previous.grantId,
        reason: "ended",
      });
  }
  acknowledge(grantId: string): void {
    this.tick();
    if (
      this.current.type === "granted" &&
      this.current.grantId === grantId
    )
      this.current = {
        ...this.current,
        deadline: this.port.now() + 2000,
      };
  }
  tick(): void {
    if (
      (this.current.type === "requesting" ||
        this.current.type === "granted") &&
      this.port.now() >= this.current.deadline
    )
      this.cancel();
  }
  /** Room leave, source change, transport failure or owner abort is terminal. */
  close(): void {
    if (this.current.type === "closed") return;
    try {
      this.cancel();
    } finally {
      this.current = { type: "closed" };
    }
  }
  private matches(binding: ControlBinding): boolean {
    return (
      binding.roomGeneration ===
        this.binding.roomGeneration &&
      binding.peerGeneration ===
        this.binding.peerGeneration &&
      binding.clientId === this.binding.clientId &&
      sameControlTarget(binding.target, this.binding.target)
    );
  }
  private endGrant(): void {
    const release = this.current.type === "granted";
    this.current = { type: "viewing" };
    if (release) {
      try {
        this.port.release();
      } catch (error) {
        this.current = { type: "closed" };
        throw error;
      }
    }
  }
  private send(message: ControlSignal): boolean {
    try {
      this.port.send(message);
      return true;
    } catch {
      this.endGrant();
      this.current = { type: "closed" };
      return false;
    }
  }
}
