import type { EventSource } from "@weblink/platform/events";
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
  join: TransferClient;
  leave: TransferClient;
};

export interface ClientServiceInitOptions {
  roomId: string;
  password: string | null;
  client: Client;
  websocketUrl?: string;
  onNotice?(
    notice:
      | "room-unprotected"
      | "password-hash-failed"
      | "session-replaced"
      | "tab-replaced",
  ): void;
}

export interface ClientJoinOptions {
  takeover?: boolean;
}

export interface ClientService {
  readonly events: EventSource<ClientServiceEventMap>;
  readonly websocketUrl?: string;
  get info(): TransferClient;

  createSender(target: ClientID): SignalingService | null;
  removeSender(target: ClientID): void;

  /** Resolves only after the server accepts and acknowledges room membership. */
  createClient(options?: ClientJoinOptions): Promise<void>;
  updateClient(options: UpdateClientOptions): Promise<void>;

  close(): void;
}
