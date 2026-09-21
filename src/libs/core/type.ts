import type { ChunkMetaData } from "../cache";
import type { TransferClient } from "./services/type";
import type { SendClipboardMessage } from "@/libs/core/protocol/messages";

export type RoomStatus = {
  roomId: RoomID | null;
  profile: ClientInfo | null;
};

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

export interface ClientInfo extends TransferClient {
  candidateType?: string;
  onlineStatus:
    | "offline"
    | "online"
    | "connecting"
    | "reconnecting";
  streamState?: "placeholder" | "media";
  clipboard?: SendClipboardMessage[];
  storage?: ChunkMetaData[];
  messageChannel: boolean;
  stream?: MediaStream;
}
export type RoomID = string;
export type ClientID = string;
export type SessionID = string;

export type FileID = string;
