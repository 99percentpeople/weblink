/** A Blob-compatible reader without requiring all native bytes in a JS Blob. */
export interface BinarySource {
  readonly size: number;
  readonly type: string;
  slice(
    start?: number,
    end?: number,
    type?: string,
  ): BinarySource;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  stream(): ReadableStream<Uint8Array<ArrayBuffer>>;
}

export interface StoredFile extends BinarySource {
  readonly name: string;
  readonly lastModified: number;
  /** Capability URL for native media. Never an unrestricted host path. */
  readonly url?: string;
}

export interface VfsStat {
  kind: "file" | "directory";
  size: number;
  modified: number;
  /** Opaque change token, not a content fingerprint. */
  revision: string;
}
export interface VfsEntry extends VfsStat {
  name: string;
}
export interface VfsWrite {
  offset: number;
  data: Uint8Array<ArrayBuffer>;
}
export interface VfsFileMetadata {
  name: string;
  type: string;
  lastModified: number;
}
export interface VfsVolumeInfo {
  id: string;
  name: string;
  kind: "indexeddb" | "directory" | "native";
}
/** Local storage identity; directory paths are relative to a registered mount. */
export type FileStorageLocation =
  | { kind: "indexeddb" }
  | {
      kind: "directory" | "native";
      mountId: string;
      path: string;
    };
export interface VfsVolume extends VfsVolumeInfo {
  readonly capabilities: {
    commit: "transaction" | "close" | "sync";
    watch: "events" | "poll" | "native";
  };
  stat(path: string): Promise<VfsStat | null>;
  list(path: string): Promise<VfsEntry[]>;
  read(
    path: string,
    offset: number,
    length: number,
  ): Promise<ArrayBuffer>;
  /** Resolves after data is committed. size sets logical length, not disk allocation. */
  commit(
    path: string,
    writes: readonly VfsWrite[],
    size?: number,
  ): Promise<VfsStat>;
  /** Replace a complete payload in one commit, without reopening between chunks. */
  writeFile?(
    path: string,
    source: BinarySource,
    signal?: AbortSignal,
    /** Bytes accepted by the writer; the returned promise confirms the final commit. */
    onWritten?: (bytes: number) => void,
  ): Promise<VfsStat>;
  /** Move within this volume without replacing a destination; null means it exists. */
  move?(
    path: string,
    destination: string,
    revision: string,
  ): Promise<VfsStat | null>;
  remove(path: string): Promise<void>;
  file(
    path: string,
    metadata: VfsFileMetadata,
  ): Promise<StoredFile>;
  /** Changes are invalidation hints; consumers must re-stat, including after reconnect. */
  watch(changed: () => void): Promise<() => void>;
}

export interface NativeFileSystem {
  volumes(): Promise<VfsVolume[]>;
  pickDirectory(): Promise<VfsVolume | null>;
  /** Open a mounted root in the system file manager; accepts a mount ID, never a path. */
  openDirectory(mountId: string): Promise<void>;
  /** Reveal an existing file in the system file manager without opening its contents. */
  revealFile?(mountId: string, path: string): Promise<void>;
}
