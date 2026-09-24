import type { ChunkCacheInfo } from "@/libs/domain/file";
import type { ContentRecord } from "@/libs/domain/file-library";

/**
 * Copy the mutable metadata fields at the persistence boundary. A spread alone
 * retains nested reactive proxies, which IndexedDB cannot clone. Keep native
 * File/Blob values intact instead of serializing them through JSON.
 */
export function snapshotFileMetadata<
  T extends ChunkCacheInfo,
>(metadata: T): T {
  return {
    ...metadata,
    fingerprint: metadata.fingerprint
      ? { ...metadata.fingerprint }
      : undefined,
    aliases: metadata.aliases
      ? [...metadata.aliases]
      : undefined,
  };
}

export function snapshotContentRecord(
  record: ContentRecord,
): ContentRecord {
  return {
    ...record,
    fingerprint: { ...record.fingerprint },
  };
}
