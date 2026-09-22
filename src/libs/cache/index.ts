import type { ClientID, FileID } from "@/libs/core/ids";

export interface ChunkMetaData {
  id: FileID;
  fileName: string;
  fileSize: number;
  lastModified?: number;
  mimetype?: string;
  chunkSize?: number;
  from?: ClientID;
  createdAt?: number;
  file?: File;
}

export type ChunkCacheInfo = Omit<ChunkMetaData, "file">;

export type ChunkCacheEventMap = {
  cleanup: void;
  update: FileMetaData | null;
  complete: File;
  merging: void;
};

export interface FileMetaData extends ChunkMetaData {
  chunkCount?: number;
  isComplete?: boolean;
  isMerging?: boolean;
}

export { DBNAME_PREFIX } from "@/constants";
