import { createBLAKE3 } from "hash-wasm";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";

export const FINGERPRINT_CHUNK_SIZE = 2 * 1024 * 1024;

/** Called in a worker; bounded memory even for multi-gigabyte files. */
export async function fingerprintBlob(
  file: Blob,
  progress?: (bytes: number) => void,
  signal?: AbortSignal,
): Promise<FileFingerprint> {
  const hasher = await createBLAKE3(256);
  hasher.init();
  for (
    let offset = 0;
    offset < file.size;
    offset += FINGERPRINT_CHUNK_SIZE
  ) {
    signal?.throwIfAborted();
    const end = Math.min(
      file.size,
      offset + FINGERPRINT_CHUNK_SIZE,
    );
    const data = await file
      .slice(offset, end)
      .arrayBuffer();
    signal?.throwIfAborted();
    hasher.update(new Uint8Array(data));
    progress?.(end);
  }
  signal?.throwIfAborted();
  return {
    version: 1,
    algorithm: "blake3-256",
    size: file.size,
    digest: hasher.digest("hex"),
  };
}
