import {
  Client,
  ClientID,
  SessionID,
  TransferClient,
} from "@/libs/core/type";
import { UpdateClientOptions } from "./client/firebase-client-service";

export interface ClientService {
  get info(): TransferClient;

  getSender: (target: ClientID) => SignalingService;
  removeSender: (target: ClientID) => void;

  listenForJoin(
    callback: (client: TransferClient) => void,
  ): void;
  listenForLeave(
    callback: (client: TransferClient) => void,
  ): void;

  createClient(): Promise<void>;
  updateClient(options: UpdateClientOptions): Promise<void>;
  destroy(): void;
}

export type Unsubscribe = () => void;

export interface SignalingService {
  sendSignal: (
    signal: RawSignal,
    options?: SendSignalOptions,
  ) => Promise<void>;
  listenForSignal: (
    callback: (signal: ClientSignal) => void,
  ) => void;

  sessionId: SessionID;
  clientId: ClientID;
  targetClientId: ClientID;

  destroy: () => void;
}

export interface RawSignal {
  type: string;
  data: string;
}

export interface ClientSignal extends RawSignal {
  sessionId: SessionID;
  clientId: ClientID;
  targetClientId: ClientID | null;
}

export type SendSignalOptions = {
  bocast?: boolean;
};

export interface ClientServiceInitOptions {
  roomId: string;
  password: string | null;
  client: Client;
}
