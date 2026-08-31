import { Client, ClientID } from "@/libs/core/type";
import { EventHandler } from "@/libs/utils/event-emitter";

export interface UpdateClientOptions {
  name?: string;
  avatar?: string | null;
}

export type ClientServiceEventMap = {
  statuschange: "connected" | "connecting" | "disconnected";
};

export interface ClientService {
  get info(): TransferClient;

  addEventListener<K extends keyof ClientServiceEventMap>(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<
    K extends keyof ClientServiceEventMap,
  >(
    event: K,
    callback: EventHandler<ClientServiceEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;

  createSender: (
    target: ClientID,
  ) => SignalingService | null;
  removeSender: (target: ClientID) => void;

  listenForJoin(
    callback: (client: TransferClient) => void,
  ): void;
  listenForLeave(
    callback: (client: TransferClient) => void,
  ): void;

  createClient(): Promise<void>;
  updateClient(options: UpdateClientOptions): Promise<void>;

  close(): void;
}

export type Unsubscribe = () => void;

export type SignalingServiceEventMap = {
  signal: ClientSignal;
  statuschange: Exclude<SignalingServiceStatus, "init">;
};

export type SignalingServiceStatus =
  | "init"
  | "connected"
  | "disconnected"
  | "closed";

export interface SignalingService {
  get status(): SignalingServiceStatus;
  sendSignal: (signal: RawSignal) => Promise<void>;
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

export interface RawSignal {
  type: string;
  data: any;
}

export interface ClientSignal extends RawSignal {
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
  websocketUrl?: string;
}

export type ClientPresence = Pick<Client, "clientId"> & {
  createdAt: number;
  rtcProfileVersion?: number;
  resume?: boolean;
};

export type TransferClient = Client & ClientPresence;
