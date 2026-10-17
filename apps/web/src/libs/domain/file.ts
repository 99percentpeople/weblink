import type { ClientID, FileID } from "./ids";
import type { EventHandler } from "@/libs/utils/event-emitter";
import type { ChunkRange } from "@/libs/utils/range";
import type { FileFingerprint } from "./protocol/file-fingerprint";
import type { StoredFile } from "@weblink/platform";
import type {
  FileStorageInfo,
  FileCapabilities,
} from "./file-storage";

export type FileSource =
  | StoredFile
  | { kind: "library"; localFileId: string };

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
  file?: StoredFile;
  fingerprint?: FileFingerprint;
  /** Local-only shared content and library retention metadata. */
  contentKey?: string;
  contentStorage?: boolean;
  libraryPinned?: boolean;
  /** Local projection of content ownership; never trust wire metadata. */
  isShared?: boolean;
  sharedReference?: boolean;
  aliases?: string[];
}

export type ChunkCacheInfo = Omit<ChunkMetaData, "file">;

export interface FileMetaData extends ChunkMetaData {
  /** Local operations on this file; never supplied by remote metadata. */
  capabilities?: FileCapabilities;
  /** Actual local mount, including unavailable or unfinished files. */
  storageMountId?: string;
  /** A recovered version must be verified before reusing its retained content key. */
  verifyContent?: boolean;
  storageUnavailable?: string;
  /** Storage confirmed this version is absent, unlike temporary loss of access. */
  storageMissing?: boolean;
  chunkCount?: number;
  /** Exact persisted bytes, including a possibly shorter final chunk. */
  cachedBytes?: number;
  isComplete?: boolean;
  isMerging?: boolean;
}

export type ChunkCacheEventMap = {
  cleanup: void;
  update: FileMetaData | null;
  complete: StoredFile;
  merging: void;
};

export interface FileWriteProgress {
  phase: "writing" | "verifying";
  /** Bytes processed in this phase; completion still requires a successful commit. */
  bytes: number;
}

export interface FileWriteOptions {
  signal?: AbortSignal;
  onProgress?(progress: FileWriteProgress): void;
}

export interface ChunkCache {
  readonly id: FileID;
  /** Durable local identity after completion; transfer/reference IDs stay unchanged. */
  storageIdentity?(): Promise<string>;
  /** Metadata-only lookup; does not read or verify file contents. */
  storageInfo?(): Promise<FileStorageInfo | null>;
  /** Reveal the current source, including an unfinished file, without exposing paths. */
  reveal?(): Promise<void>;

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
  setInfo(
    data: Omit<ChunkMetaData, "id">,
    signal?: AbortSignal,
    onProgress?: (progress: FileWriteProgress) => void,
  ): Promise<void>;
  getInfo(): Promise<FileMetaData | null>;
  getChunk(chunkIndex: number): Promise<ArrayBuffer | null>;
  getChunkCount(): Promise<number>;
  getReqRanges(): Promise<ChunkRange[] | null>;
  getFile(): Promise<StoredFile | null>;
  /** Verify this snapshot once per live version. Optional computation retains the caller's worker/progress UI. */
  fingerprint?(
    file: StoredFile,
    options?: FileWriteOptions,
    compute?: () => Promise<FileFingerprint>,
  ): Promise<FileFingerprint | undefined>;
  flush(): Promise<void>;
  /** Release cache ownership. Only explicit deletion may also remove an indexed source file. */
  cleanup(options?: {
    deleteSource?: boolean;
  }): Promise<void>;
  calcCachedBytes(): Promise<number | null>;
  getCachedKeys(): Promise<number[]>;
  isTransferComplete(): Promise<boolean>;
  mergeFile(): Promise<StoredFile | null>;
  /** Production receivers verify/promote immutable content before completion. */
  verifyFile?(
    signal?: AbortSignal,
  ): Promise<StoredFile | null>;
  refresh?(): Promise<void>;
  dispose?(): void;
  retireReceiveStorage?(): Promise<void>;
}

export function getTotalChunkCount(
  info: FileMetaData,
): number {
  if (!info.chunkSize) {
    throw new Error("chunkSize is not found");
  }
  return Math.ceil(info.fileSize / info.chunkSize);
}
