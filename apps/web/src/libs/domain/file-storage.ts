import type {
  VfsVolume,
  VfsVolumeInfo,
  StoredFile,
  VfsWrite,
} from "@weblink/platform";
import type { ChunkCache } from "./file";
import type { StorageMigrationProgress } from "./storage-migration";

/** Local operations, resolved from the file's own backing store, never the default mount. */
export interface FileCapabilities {
  save: "download" | "save-as";
  /** Native files already have a useful location; keep their bubble actions compact. */
  inlineSave: boolean;
  reveal: boolean;
}

export interface FileStorageInfo {
  mountId: string;
  capabilities: FileCapabilities;
}

export interface FileStorageSnapshot {
  files: string[];
  /** Confirmed removals only. An inaccessible mount retains its previous membership. */
  removed: string[];
}

export interface FileStorageMount extends VfsVolumeInfo {
  canOpen: boolean;
}
export interface StorageAuthorizationOptions {
  /** Imports refresh existing identities before deduplication. New generated
   * files can defer that scan to ordinary background synchronization. */
  refresh?: boolean;
}
export interface WritableStoredFile {
  readonly mountId: string;
  write(bytes: Uint8Array<ArrayBuffer>): Promise<void>;
  finish(
    patches?: readonly VfsWrite[],
  ): Promise<{ id: string; file: StoredFile }>;
  /** Release the session, retaining committed bytes as an unavailable draft. */
  abort(): Promise<void>;
}

/** Storage administration is separate from file/transfer operations. */
export interface FileStorageSettings {
  readonly defaultMountId: string;
  readonly canMountDirectory: boolean;
  mounts(): FileStorageMount[];
  openDirectory(id: string): Promise<void>;
  getVolume(id: string): Promise<VfsVolume>;
  setDefault(id: string): Promise<void>;
  mountDirectory(): Promise<string | null>;
  authorize(
    id: string,
    options?: StorageAuthorizationOptions,
  ): Promise<void>;
}

export interface FileStorage extends FileStorageSettings {
  initialize(): Promise<void>;
  list(): Promise<string[]>;
  synchronize(): Promise<FileStorageSnapshot>;
  createWritableFile(options: {
    name: string;
    type: string;
    signal?: AbortSignal;
  }): Promise<WritableStoredFile>;
  createCache(
    id: string,
    options: {
      memoryChunks: number;
      isRetained: () => boolean;
      existingOnly?: boolean;
    },
  ): Promise<ChunkCache>;
  /** Explicit deletion of the selected source, including a deduplicated alias. */
  removeSource(id: string): Promise<void>;
  /** Invoke during the import gesture, before asynchronous preparation. */
  authorizeDefault(
    options?: StorageAuthorizationOptions,
  ): Promise<void>;
  onChange(
    listener: (mountId?: string) => void,
  ): () => void;
  onMigrationProgress(
    listener: (progress: StorageMigrationProgress) => void,
  ): () => void;
  dispose(): void;
}
