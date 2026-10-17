import type { ChunkMetaData } from "@/libs/domain/file";
import {
  requestResult,
  transactionDone,
} from "@/libs/infrastructure/storage/indexeddb-helpers";

/** Produces the retired on-disk format without keeping its runtime implementation. */
export async function legacyDatabase(
  id: string,
  info: Omit<ChunkMetaData, "id"> | null,
  chunks: {
    chunkIndex: number;
    data: Blob | ArrayBuffer;
  }[] = [],
): Promise<IDBDatabase> {
  const request = indexedDB.open(`file-${id}`, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("info", {
      keyPath: "id",
    });
    request.result.createObjectStore("chunks", {
      keyPath: "chunkIndex",
    });
  };
  const db = await requestResult(request);
  const tx = db.transaction(
    ["info", "chunks"],
    "readwrite",
  );
  const done = transactionDone(tx);
  if (info) tx.objectStore("info").put({ ...info, id });
  for (const chunk of chunks)
    tx.objectStore("chunks").put(chunk);
  await done;
  return db;
}
