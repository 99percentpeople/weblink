import type {
  ChunkMetaData,
  FileMetaData,
} from "@/libs/cache";
import type { ChunkCache } from "@/libs/cache/chunk-cache";
import type { EventHandler } from "@/libs/utils/event-emitter";
import type { ChunkRange } from "@/libs/utils/range";
import type { CompressionLevel } from "./options";
import type { FileID } from "../ids";

export enum TransferMode {
  Send = 1,
  Receive = 2,
}

export interface BaseTransferMessage {
  type: string;
}

export interface HeadMessage
  extends BaseTransferMessage, ChunkMetaData {
  type: "head";
}
export interface RequestContentMessage extends BaseTransferMessage {
  type: "request-content";
  ranges: ChunkRange[];
}
export interface RequestHeadMessage extends BaseTransferMessage {
  type: "request-head";
}

export interface CompleteMessage extends BaseTransferMessage {
  type: "complete";
}

export interface PauseMessage extends BaseTransferMessage {
  type: "pause";
}

export type TransferMessage =
  | RequestContentMessage
  | RequestHeadMessage
  | HeadMessage
  | CompleteMessage
  | PauseMessage;

export { TRANSFER_CHANNEL_PREFIX } from "@/constants";

export interface FileTransfererOptions {
  cache: ChunkCache;
  info?: FileMetaData;
  blockSize?: number;
  bufferedAmountLowThreshold?: number;
  bufferedAmountHighWaterMark?: number;
  compressionLevel?: CompressionLevel;
}

export type ProgressValue = {
  total: number;
  received: number;
};

export type FileTransfererEventMap = {
  progress: ProgressValue;
  complete: void;
  error: Error;
  ready: void;
  close: void;
};

export interface FileTransferer {
  readonly cache: ChunkCache;
  readonly mode: TransferMode;
  readonly id: FileID;
  channel: RTCDataChannel | null;
  setChannel(channel: RTCDataChannel): void;
  initialize(): Promise<void>;
  pause(notify?: boolean): Promise<void>;
  close(): void;
  addEventListener<K extends keyof FileTransfererEventMap>(
    eventName: K,
    handler: EventHandler<FileTransfererEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<
    K extends keyof FileTransfererEventMap,
  >(
    eventName: K,
    handler: EventHandler<FileTransfererEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void;
}
