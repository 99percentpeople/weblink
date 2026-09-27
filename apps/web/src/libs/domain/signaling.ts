import type { EventHandler } from "@/libs/utils/event-emitter";
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
  get status(): SignalingServiceStatus;
  sendSignal(signal: RawSignal): Promise<void>;

  addEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<
    K extends keyof SignalingServiceEventMap,
  >(
    event: K,
    callback: EventHandler<SignalingServiceEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void;

  clientId: ClientID;
  targetClientId: ClientID;

  close(): void;
}
