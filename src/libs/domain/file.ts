import type { ClientID, FileID } from "./ids";
import type { EventHandler } from "@/libs/utils/event-emitter";
import type { ChunkRange } from "@/libs/utils/range";

export interface ChunkMetaData {
  id: FileID;
  fileName: string;
  fileSize: number;
  lastModified?: number;
  mimetype?: string;
  chunkSize?: number;
  from?: ClientID;
  /** Local authorization scope and retention; never inferred from a legacy request. */
  roomAttachment?: boolean;
  roomOfferId?: string;
  createdAt?: number;
  file?: File;
}

export type ChunkCacheInfo = Omit<ChunkMetaData, "file">;

export interface FileMetaData extends ChunkMetaData {
  chunkCount?: number;
  isComplete?: boolean;
  isMerging?: boolean;
}

export type ChunkCacheEventMap = {
  cleanup: void;
  update: FileMetaData | null;
  complete: File;
  merging: void;
};

export interface ChunkCache {
  readonly id: FileID;

  addEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;

  removeEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void;

  initialize(): Promise<void>;
  storeChunk(
    chunkIndex: number,
    data: ArrayBufferLike,
  ): Promise<void>;
  setInfo(data: Omit<ChunkMetaData, "id">): Promise<void>;
  getInfo(): Promise<FileMetaData | null>;
  getChunk(chunkIndex: number): Promise<ArrayBuffer | null>;
  getChunkCount(): Promise<number>;
  getReqRanges(): Promise<ChunkRange[] | null>;
  getFile(): Promise<File | null>;
  flush(): Promise<void>;
  cleanup(): Promise<void>;
  calcCachedBytes(): Promise<number | null>;
  getCachedKeys(): Promise<number[]>;
  isTransferComplete(): Promise<boolean>;
  mergeFile(): Promise<File | null>;
}

export function getTotalChunkCount(
  info: FileMetaData,
): number {
  if (!info.chunkSize) {
    throw new Error("chunkSize is not found");
  }
  return Math.ceil(info.fileSize / info.chunkSize);
}
