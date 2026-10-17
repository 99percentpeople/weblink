import type {
  VfsVolume,
  VfsVolumeInfo,
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

/** Storage administration is separate from file/transfer operations. */
export interface FileStorageSettings {
  readonly defaultMountId: string;
  readonly canMountDirectory: boolean;
  mounts(): FileStorageMount[];
  openDirectory(id: string): Promise<void>;
  getVolume(id: string): Promise<VfsVolume>;
  setDefault(id: string): Promise<void>;
  mountDirectory(): Promise<string | null>;
  authorize(id: string): Promise<void>;
}

export interface FileStorage extends FileStorageSettings {
  initialize(): Promise<void>;
  list(): Promise<string[]>;
  synchronize(): Promise<FileStorageSnapshot>;
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
  authorizeDefault(): Promise<void>;
  onChange(
    listener: (mountId?: string) => void,
  ): () => void;
  onMigrationProgress(
    listener: (progress: StorageMigrationProgress) => void,
  ): () => void;
  dispose(): void;
}
