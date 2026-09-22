import type { EventHandler } from "@/libs/utils/event-emitter";
import type { SignalingService } from "./signaling";
import type { ClientID, RoomID } from "./ids";

export interface UpdateProfile {
  name?: string;
  roomId?: RoomID;
  clientId?: ClientID;
}

export interface Client {
  clientId: ClientID;
  name: string;
  avatar: string | null;
}

export interface CreateClient extends Client {
  password?: string;
}

export type ClientPresence = Pick<Client, "clientId"> & {
  createdAt: number;
  rtcProfileVersion?: number;
  resume?: boolean;
};

export type TransferClient = Client & ClientPresence;

export interface UpdateClientOptions {
  name?: string;
  avatar?: string | null;
}

export type ClientServiceEventMap = {
  statuschange: "connected" | "connecting" | "disconnected";
};

export interface ClientServiceInitOptions {
  roomId: string;
  password: string | null;
  client: Client;
  websocketUrl?: string;
}

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

  createSender(target: ClientID): SignalingService | null;
  removeSender(target: ClientID): void;

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
