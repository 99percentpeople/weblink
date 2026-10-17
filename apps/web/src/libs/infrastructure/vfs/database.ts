import type {
  ChunkCacheInfo,
  FileWriteOptions,
  FileWriteProgress,
} from "@/libs/domain/file";
import type {
  StoredFile,
  VfsVolumeInfo,
} from "@/libs/domain/vfs";
import {
  requestResult,
  transactionDone,
} from "../storage/indexeddb-helpers";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";

export interface StoredMount extends VfsVolumeInfo {
  handle?: FileSystemDirectoryHandle;
}
export interface StoredVfsFile {
  id: string;
  mountId: string;
  path: string;
  info: ChunkCacheInfo | null;
  chunks: Record<number, string>;
  complete: boolean;
  revision?: string;
  checkpointVersion?: number;
  /** Identifies a verified migration whose old database may still await deletion. */
  migrationSource?: string;
  /** Reconstructed from the partial file while publishing its final name. */
  finalization?: { source: string; target: string };
  /** Ordinary files discovered in a mount are read in place, never transfer destinations. */
  source?: "directory";
  present?: boolean;
  /** Ephemeral facts reconstructed from a directory, never required for recovery. */
  verifyContent?: boolean;
  error?: string;
}

export interface VfsFileStore {
  file(
    id: string,
    cached?: StoredVfsFile,
  ): Promise<StoredVfsFile | undefined>;
  checkpoint(
    record: StoredVfsFile,
    added?: readonly (readonly [number, string])[],
    removed?: readonly number[],
    options?: FileWriteOptions,
  ): Promise<void>;
  removeFile(id: string): Promise<void>;
  create?(
    record: StoredVfsFile,
    info: ChunkCacheInfo,
    file?: StoredFile,
    signal?: AbortSignal,
    onProgress?: (progress: FileWriteProgress) => void,
  ): Promise<void>;
  identity?(record: StoredVfsFile): Promise<string>;
  fingerprint?(
    record: StoredVfsFile,
    file: StoredFile,
    options?: FileWriteOptions,
    compute?: () => Promise<FileFingerprint>,
  ): Promise<FileFingerprint>;
}

export class VfsDatabase {
  private opening?: Promise<IDBDatabase>;
  constructor(private readonly name = "weblink-vfs-v1") {}
  open(): Promise<IDBDatabase> {
    return (this.opening ??= new Promise(
      (resolve, reject) => {
        const request = indexedDB.open(this.name, 2);
        request.onupgradeneeded = () => {
          for (const name of [
            "mounts",
            "files",
            "nodes",
            "pages",
            "settings",
            "checkpoints",
          ])
            if (
              !request.result.objectStoreNames.contains(
                name,
              )
            )
              request.result.createObjectStore(name);
        };
        request.onerror = () => {
          this.opening = undefined;
          reject(request.error);
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.opening = undefined;
          };
          resolve(db);
        };
      },
    ));
  }
  async get<T>(
    store: string,
    key: IDBValidKey,
  ): Promise<T | undefined> {
    const tx = (await this.open()).transaction(store);
    const [result] = await Promise.all([
      requestResult(tx.objectStore(store).get(key)),
      transactionDone(tx),
    ]);
    return result;
  }
  async all<T>(store: string): Promise<T[]> {
    const tx = (await this.open()).transaction(store);
    const [result] = await Promise.all([
      requestResult(tx.objectStore(store).getAll()),
      transactionDone(tx),
    ]);
    return result;
  }
  async put(
    store: string,
    key: IDBValidKey,
    value: unknown,
  ): Promise<void> {
    const tx = (await this.open()).transaction(
      store,
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore(store).put(value, key);
    await done;
  }
  async delete(
    store: string,
    key: IDBValidKey,
  ): Promise<void> {
    const tx = (await this.open()).transaction(
      store,
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore(store).delete(key);
    await done;
  }
  async close(): Promise<void> {
    (await this.opening)?.close();
    this.opening = undefined;
  }
  /** Reuse hashes while the small metadata revision matches, including across chunks. */
  async file(
    id: string,
    cached?: StoredVfsFile,
  ): Promise<StoredVfsFile | undefined> {
    const tx = (await this.open()).transaction([
      "files",
      "checkpoints",
    ]);
    const done = transactionDone(tx);
    try {
      const record = await requestResult<
        StoredVfsFile | undefined
      >(tx.objectStore("files").get(id));
      if (!record) {
        await done;
        return;
      }
      if (
        cached &&
        record.checkpointVersion ===
          cached.checkpointVersion
      )
        record.chunks = cached.chunks;
      else {
        const entries = await requestResult<
          { index: number; hash: string }[]
        >(
          tx
            .objectStore("checkpoints")
            .getAll(
              IDBKeyRange.bound(
                [id, 0],
                [id, Number.MAX_SAFE_INTEGER],
              ),
            ),
        );
        record.chunks = {
          ...record.chunks,
          ...Object.fromEntries(
            entries.map(({ index, hash }) => [index, hash]),
          ),
        };
      }
      await done;
      return record;
    } catch (error) {
      await done.catch(() => {});
      throw error;
    }
  }
  /** Bytes are already committed; update only changed chunk rows, atomically with metadata. */
  async checkpoint(
    record: StoredVfsFile,
    added: readonly (readonly [number, string])[] = [],
    removed: readonly number[] = [],
  ): Promise<void> {
    const tx = (await this.open()).transaction(
      ["files", "checkpoints"],
      "readwrite",
    );
    const done = transactionDone(tx);
    const { chunks, ...metadata } = record;
    const checkpointVersion =
      (record.checkpointVersion ?? 0) + 1;
    try {
      const store = tx.objectStore("checkpoints");
      const entries =
        record.checkpointVersion === undefined
          ? Object.entries(chunks).map(
              ([index, hash]) =>
                [Number(index), hash] as const,
            )
          : added;
      for (const [index, hash] of entries)
        store.put({ index, hash }, [record.id, index]);
      for (const index of removed)
        store.delete([record.id, index]);
      tx.objectStore("files").put(
        { ...metadata, checkpointVersion },
        record.id,
      );
      await done;
      record.checkpointVersion = checkpointVersion;
    } catch (error) {
      try {
        tx.abort();
      } catch {}
      await done.catch(() => {});
      throw error;
    }
  }
  async removeFile(id: string): Promise<void> {
    const tx = (await this.open()).transaction(
      ["files", "checkpoints"],
      "readwrite",
    );
    const done = transactionDone(tx);
    tx.objectStore("files").delete(id);
    tx.objectStore("checkpoints").delete(
      IDBKeyRange.bound(
        [id, 0],
        [id, Number.MAX_SAFE_INTEGER],
      ),
    );
    await done;
  }
}
