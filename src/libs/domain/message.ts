import type { FileFingerprint } from "./protocol/file-fingerprint";
import type { FileID } from "./ids";
import type { BaseExchangeMessage } from "./protocol/messages";

export interface BaseStorageMessage extends BaseExchangeMessage {
  id: string;
  /** Optional only while importing pre-conversation history. */
  conversationId?: string;
  /** Monotonic arrival order in this browser; never transmitted. */
  localSequence?: number;
  status?: "sending" | "received" | "error";
  room?: {
    roomId: string;
    senderName: string;
    senderAvatar: string | null;
  };
  deliveries?: Record<string, RoomDeliveryStatus>;
}

export type RoomDeliveryStatus =
  | "sending"
  | "delivered"
  | "failed"
  | "unsupported";

export interface TextMessage extends BaseStorageMessage {
  type: "text";
  data: string;
  error?: string;
}

export type RoomFileTransferState = {
  completionSource?: "local" | "network";
  status?:
    | "init"
    | "transfering"
    | "complete"
    | "paused"
    | "error";
  progress?: { total: number; received: number };
  error?: string;
};

export interface FileTransferMessage extends BaseStorageMessage {
  type: "file";
  fingerprint?: FileFingerprint;
  localContentPending?: boolean;
  localContentDetached?: boolean;
  completionSource?: "local" | "network";
  fid?: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
  error?: string;
  /** Sender-side download state for each original offer recipient. */
  roomTransfers?: Record<string, RoomFileTransferState>;
  progress?: {
    total: number;
    received: number;
  };
  transferStatus?:
    | "init"
    | "transfering"
    | "complete"
    | "paused"
    | "error";
}

export type StoreMessage =
  | TextMessage
  | FileTransferMessage;

/** The room field is required and checked by the room persistence boundary. */
export type RoomMessage = TextMessage | FileTransferMessage;
