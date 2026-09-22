import type { FileID } from "./ids";
import type { BaseExchangeMessage } from "./protocol/messages";

export interface BaseStorageMessage extends BaseExchangeMessage {
  id: string;
}

export interface TextMessage extends BaseStorageMessage {
  type: "text";
  data: string;
  error?: string;
}

export interface FileTransferMessage extends BaseStorageMessage {
  type: "file";
  fid?: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
  error?: string;
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
