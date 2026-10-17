import type { ChunkMetaData } from "./file";

export function expectedChunkSize(
  info: ChunkMetaData,
  index: number,
): number {
  if (
    !Number.isSafeInteger(info.fileSize) ||
    info.fileSize < 0 ||
    !Number.isSafeInteger(info.chunkSize) ||
    !info.chunkSize ||
    info.chunkSize < 1
  )
    throw new Error("Invalid file size or chunk size");
  const count = Math.ceil(info.fileSize / info.chunkSize);
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count
  )
    throw new Error(`Unexpected chunk index ${index}`);
  return Math.min(
    info.chunkSize,
    info.fileSize - index * info.chunkSize,
  );
}
