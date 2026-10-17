import type { ChunkMetaData } from "@/libs/domain/file";
import { expectedChunkSize } from "@/libs/domain/file-chunks";
import {
  requestResult,
  transactionDone,
} from "./indexeddb-helpers";

// Only the migrator understands the retired per-file database format.
export const LEGACY_DATABASE_PREFIX = "file-";
const INFO = "migration-info";
const CHUNKS = "migration-chunks";

export interface LegacySource {
  info: ChunkMetaData | null;
  keys: number[];
  chunk(index: number): Promise<Blob>;
  close(): void;
}

function schema(
  db: IDBDatabase,
  info: string,
  chunks: string,
): boolean {
  return (
    db.objectStoreNames.length === 2 &&
    db.objectStoreNames.contains(info) &&
    db.objectStoreNames.contains(chunks)
  );
}

/** Never create a database that disappeared between enumeration and opening. */
function openExisting(
  name: string,
  signal: AbortSignal,
  waiting: () => void,
  version?: number,
): Promise<IDBDatabase | null> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    let missing = false;
    let failure: unknown;
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const cleanup = () =>
      signal.removeEventListener("abort", abort);
    request.onblocked = waiting;
    request.onupgradeneeded = (event) => {
      if (event.oldVersion === 0) missing = true;
      try {
        signal.throwIfAborted();
        if (missing) {
          request.transaction!.abort();
          return;
        }
        const db = request.result;
        if (!schema(db, "info", "chunks"))
          throw new Error(
            "Unrecognized legacy cache schema",
          );
        // Upgrading waits for every old connection to close. Renaming fences
        // old clients from writing again between verification and deletion.
        request.transaction!.objectStore("info").name =
          INFO;
        request.transaction!.objectStore("chunks").name =
          CHUNKS;
      } catch (error) {
        failure = error;
        request.transaction!.abort();
      }
    };
    request.onerror = () => {
      cleanup();
      if (missing && !signal.aborted) resolve(null);
      else reject(failure ?? request.error);
    };
    request.onsuccess = () => {
      cleanup();
      const db = request.result;
      db.onversionchange = () => db.close();
      if (signal.aborted) {
        db.close();
        reject(signal.reason);
      } else resolve(db);
    };
  });
}

export async function openLegacySource(
  name: string,
  signal: AbortSignal,
  waiting: () => void,
): Promise<LegacySource | null> {
  let db = await openExisting(name, signal, waiting);
  if (!db) return null;
  try {
    if (!schema(db, INFO, CHUNKS)) {
      if (!schema(db, "info", "chunks"))
        throw new Error("Unrecognized legacy cache schema");
      const version = db.version + 1;
      db.close();
      db = await openExisting(
        name,
        signal,
        waiting,
        version,
      );
      if (!db) return null;
    }
    if (!schema(db, INFO, CHUNKS))
      throw new Error("Legacy cache could not be sealed");
    const tx = db.transaction([INFO, CHUNKS]);
    const [infos, rawKeys] = await Promise.all([
      requestResult<ChunkMetaData[]>(
        tx.objectStore(INFO).getAll(),
      ),
      requestResult(tx.objectStore(CHUNKS).getAllKeys()),
      transactionDone(tx),
    ]);
    const id = name.slice(LEGACY_DATABASE_PREFIX.length);
    const info = infos[0] ?? null;
    if (infos.length > 1 || (!info && rawKeys.length))
      throw new Error(
        "Legacy cache metadata is missing or ambiguous",
      );
    if (
      info &&
      (info.id !== id ||
        typeof info.fileName !== "string" ||
        !Number.isSafeInteger(info.fileSize) ||
        info.fileSize < 0)
    )
      throw new Error("Invalid legacy file metadata");
    if (
      info?.file &&
      (!(info.file instanceof Blob) ||
        info.file.size !== info.fileSize)
    )
      throw new Error("Invalid legacy completed file");
    // A stored completed File is authoritative: legacy merging committed it
    // together with chunk deletion. Otherwise retain exactly the committed keys.
    const keys = info?.file
      ? []
      : rawKeys.map((key) => {
          if (typeof key !== "number")
            throw new Error("Invalid legacy chunk key");
          expectedChunkSize(info!, key);
          return key;
        });
    if (
      info &&
      !info.file &&
      info.fileSize > 0 &&
      (!Number.isSafeInteger(info.chunkSize) ||
        !info.chunkSize ||
        info.chunkSize < 1)
    )
      throw new Error("Invalid legacy chunk size");
    const connection = db;
    const close = () => {
      signal.removeEventListener("abort", close);
      connection.close();
    };
    signal.addEventListener("abort", close, { once: true });
    return {
      info,
      keys,
      close,
      async chunk(index) {
        signal.throwIfAborted();
        const tx = connection.transaction(CHUNKS);
        const [record] = await Promise.all([
          requestResult<
            | {
                chunkIndex: number;
                data: Blob | ArrayBuffer;
              }
            | undefined
          >(tx.objectStore(CHUNKS).get(index)),
          transactionDone(tx),
        ]);
        const data = record?.data;
        const size =
          data instanceof Blob
            ? data.size
            : data instanceof ArrayBuffer
              ? data.byteLength
              : -1;
        if (
          record?.chunkIndex !== index ||
          size !== expectedChunkSize(info!, index)
        )
          throw new Error(`Invalid legacy chunk ${index}`);
        return data instanceof Blob
          ? data
          : new Blob([data as ArrayBuffer]);
      },
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}

export function deleteLegacyDatabase(
  name: string,
  signal: AbortSignal,
  waiting: () => void,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    request.onblocked = waiting;
    request.onerror = () => {
      signal.removeEventListener("abort", abort);
      reject(request.error);
    };
    request.onsuccess = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
  });
}
