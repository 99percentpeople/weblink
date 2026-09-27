import type { ChunkCacheInfo } from "./file";
import type { FileFingerprint } from "./protocol/file-fingerprint";

export interface ContentRecord {
  key: string;
  fingerprint: FileFingerprint;
  storageId: string;
  createdAt: number;
  state: "pending" | "ready";
  /** Missing on pre-sharing caches: private by default. */
  isShared?: boolean;
  sharedReferenceId?: string;
}
export interface FileReference extends ChunkCacheInfo {
  contentKey: string;
  fingerprint: FileFingerprint;
}
export interface FileLibraryRepository {
  contents(): Promise<ContentRecord[]>;
  content(key: string): Promise<ContentRecord | undefined>;
  claim(record: ContentRecord): Promise<boolean>;
  commit(
    record: ContentRecord,
    reference: FileReference,
  ): Promise<void>;
  references(key?: string): Promise<FileReference[]>;
  reference(id: string): Promise<FileReference | undefined>;
  putReference(reference: FileReference): Promise<void>;
  removeReference(id: string): Promise<void>;
  removeContent(key: string): Promise<void>;
}
