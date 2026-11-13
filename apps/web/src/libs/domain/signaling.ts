import type { EventSource } from "@weblink/platform/events";
import type { ClientID } from "./ids";
import type { SignalingEnvelope } from "./signaling-protocol";

export type RawSignal = SignalingEnvelope<any>;

export interface ClientSignal extends RawSignal {
  clientId: ClientID;
  targetClientId: ClientID | null;
}

export type SignalingServiceStatus =
  | "init"
  | "connected"
  | "disconnected"
  | "closed";

export type SignalingServiceEventMap = {
  signal: ClientSignal;
  statuschange: Exclude<SignalingServiceStatus, "init">;
  // Server-confirmed remote socket availability, not WebRTC readiness.
  peeravailable: undefined;
};

export interface SignalingService {
  readonly events: EventSource<SignalingServiceEventMap>;
  get status(): SignalingServiceStatus;
  sendSignal(signal: RawSignal): Promise<void>;

  clientId: ClientID;
  targetClientId: ClientID;

  close(): void;
}
