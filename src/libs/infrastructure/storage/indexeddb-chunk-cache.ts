import { DBNAME_PREFIX } from "@/constants";
import type {
  ChunkCache,
  ChunkCacheEventMap,
  ChunkMetaData,
  FileMetaData,
} from "@/libs/domain/file";
import { getTotalChunkCount } from "@/libs/domain/file";
import type { EventHandler } from "@/libs/utils/event-emitter";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { ChunkRange } from "@/libs/utils/range";
import { getSubRanges } from "@/libs/utils/range";
import MergeChunkWorker from "./merge-worker?worker";
import { snapshotFileMetadata } from "./metadata-snapshot";
import {
  expectedChunkSize,
  requestResult,
  transactionDone,
  type MergeMetrics,
  type MergeResult,
  type StoredChunk,
} from "./chunk-assembly";

export interface IDBChunkCacheOptions {
  id: string;
  maxMomeryCacheSize: number;
  createMergeWorker?: () => Worker;
  isRetained?: () => boolean;
}

function cachedBytes(
  info: ChunkMetaData,
  count: number,
  last: IDBValidKey | undefined,
): number | undefined {
  if (info.file) return info.fileSize;
  if (!info.chunkSize) return undefined;
  const shortTail =
    last === Math.ceil(info.fileSize / info.chunkSize) - 1
      ? info.chunkSize -
        (info.fileSize % info.chunkSize || info.chunkSize)
      : 0;
  return Math.min(
    info.fileSize,
    Math.max(0, count * info.chunkSize - shortTail),
  );
}

export class IDBChunkCache implements ChunkCache {
  private db: IDBDatabase | null = null;
  private isMerging = false;
  private eventEmitter =
    new MultiEventEmitter<ChunkCacheEventMap>();
  public readonly id: string;
  private info: FileMetaData | null = null;
  // Snapshot at receipt, not at finalization. Duplicate buffered chunks replace
  // their previous value without inflating the persisted chunk count.
  private memoryCache = new Map<number, Blob>();
  private flushPromise: Promise<void> | null = null;
  private flushTransaction: IDBTransaction | null = null;
  private mergePromise: Promise<File | null> | null = null;
  private cancelMerge?: (error: Error) => void;
  private cleanupPromise: Promise<void> | null = null;
  private generation = 0;
  private metrics: MergeMetrics | null = null;
  private readonly createMergeWorker: () => Worker;
  private readonly isRetained: () => boolean;

  get mergeMetrics(): MergeMetrics | null {
    return this.metrics;
  }

  private maxMomeryCacheSize: number;
  constructor(options: IDBChunkCacheOptions) {
    this.id = options.id;
    this.isRetained = options.isRetained ?? (() => false);
    this.maxMomeryCacheSize = options.maxMomeryCacheSize;
    this.createMergeWorker =
      options.createMergeWorker ??
      (() => new MergeChunkWorker());
  }

  async initialize() {
    if (this.db) {
      console.warn(`db has already initialized`);
      return;
    }
    this.db = await this.initDB();
    const info = await this.getInfo();
    if (info) {
      this.dispatchEvent("update", info);
    }

    await this.isEmpty();
  }

  addEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      eventName,
      handler,
      options,
    );
  }

  removeEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
      options,
    );
  }

  private dispatchEvent<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    event: ChunkCacheEventMap[K],
  ) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  async calcCachedBytes() {
    const info = await this.getInfo();
    return info?.cachedBytes ?? null;
  }

  async getCachedKeys() {
    await this.flush();
    const store = await this.getChunkStore();
    const request = store.getAllKeys();
    const keys = await new Promise<Array<number>>(
      (reslove, reject) => {
        request.onsuccess = () =>
          reslove(request.result as number[]);
        request.onerror = () => reject(request.error);
      },
    );
    return keys;
  }

  async getReqRanges(): Promise<ChunkRange[] | null> {
    const info = await this.getInfo();
    if (!info) {
      return null;
    }

    if (!info.chunkSize) {
      return null;
    }

    if (info.file) return [];
    const totalLength = Math.ceil(
      info.fileSize / info.chunkSize,
    );

    const ranges = getSubRanges(
      totalLength,
      await this.getCachedKeys(),
    );

    return ranges;
  }

  private async initDB() {
    return await new Promise<IDBDatabase>(
      (resolve, reject) => {
        const request = indexedDB.open(
          `${DBNAME_PREFIX}${this.id}`,
        );

        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("info", {
            keyPath: "id",
          });
          db.createObjectStore("chunks", {
            keyPath: "chunkIndex",
          });
        };

        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            if (this.db === db) {
              this.generation++;
              this.cancelMerge?.(
                new DOMException(
                  "Cache connection closed",
                  "AbortError",
                ),
              );
              this.db = null;
              this.info = null;
              this.memoryCache.clear();
            }
            db.close();
          };
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      },
    );
  }

  async isEmpty() {
    let info = this.info;
    if (!info) {
      info = await this.getInfo();
    }
    const count = await this.getChunkCount();
    let empty = true;
    if (!info && count === 0) {
      empty = false;
    }

    return empty;
  }

  async isTransferComplete() {
    let info = this.info;
    if (!info) {
      info = await this.getInfo();
    }
    if (!info) {
      return false;
    }
    if (info.isComplete) {
      return true;
    }

    const count = await this.getChunkCount();
    const total = getTotalChunkCount(info);

    console.log(
      `check file ${info.fileName} total:${total} count:${count}`,
    );

    if (total === count) {
      return true;
    }

    return false;
  }

  private async getChunkStore(mode?: IDBTransactionMode) {
    const db = this.db;
    if (!db) {
      throw new Error("db is not initialized");
    }
    const transaction = db.transaction("chunks", mode);

    const store = transaction.objectStore("chunks");

    return store;
  }

  private database(): IDBDatabase {
    if (!this.db) throw new Error("db is not initialized");
    return this.db;
  }

  private assertGeneration(generation: number): void {
    if (generation !== this.generation || !this.db)
      throw new DOMException(
        "Cache operation cancelled",
        "AbortError",
      );
  }

  public async setInfo(data: ChunkMetaData): Promise<void> {
    if (this.mergePromise)
      throw new Error(
        "Cannot change file metadata during assembly",
      );
    const generation = this.generation;
    const setData = snapshotFileMetadata({
      ...data,
      id: this.id,
    });
    await this.flush();
    this.assertGeneration(generation);
    const transaction = this.database().transaction(
      ["info", "chunks"],
      "readwrite",
    );
    const done = transactionDone(transaction);
    try {
      transaction.objectStore("info").put(setData);
      const [chunkCount, last] = await Promise.all([
        requestResult(
          transaction.objectStore("chunks").count(),
        ),
        requestResult(
          transaction
            .objectStore("chunks")
            .openKeyCursor(null, "prev"),
        ),
        done,
      ]);
      this.assertGeneration(generation);
      this.info = {
        ...setData,
        isComplete: !!setData.file,
        chunkCount,
        cachedBytes: cachedBytes(
          setData,
          chunkCount,
          last?.key,
        ),
        isMerging: false,
      };
      this.dispatchEvent("update", this.info);
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        /* Already committed/aborted. */
      }
      await done.catch(() => {});
      // Later requests report AbortError when the write fails. Keep the actual
      // storage failure so callers do not mistake it for user cancellation.
      throw transaction.error ?? error;
    }
  }

  public async getInfo(): Promise<FileMetaData | null> {
    const generation = this.generation;
    await this.flush();
    this.assertGeneration(generation);
    const transaction = this.database().transaction(
      ["info", "chunks"],
      "readonly",
    );
    const [data, chunkCount, last] = await Promise.all([
      requestResult<ChunkMetaData | undefined>(
        transaction.objectStore("info").get(this.id),
      ),
      requestResult(
        transaction.objectStore("chunks").count(),
      ),
      requestResult(
        transaction
          .objectStore("chunks")
          .openKeyCursor(null, "prev"),
      ),
      transactionDone(transaction),
    ]);
    this.assertGeneration(generation);
    this.info = data
      ? {
          ...data,
          isComplete: !!data.file,
          chunkCount,
          cachedBytes: cachedBytes(
            data,
            chunkCount,
            last?.key,
          ),
          isMerging: this.isMerging,
        }
      : null;
    return this.info;
  }

  // Every caller waits for the current commit and for any chunks arriving during
  // it. A failed transaction restores its batch; retries never lose buffered data.
  flush(): Promise<void> {
    if (this.flushPromise)
      return this.flushPromise.then(() => this.flush());
    if (!this.memoryCache.size) return Promise.resolve();
    const batch = this.memoryCache;
    this.memoryCache = new Map();
    const pending = this.writeBatch(batch).finally(() => {
      if (this.flushPromise === pending)
        this.flushPromise = null;
    });
    this.flushPromise = pending;
    return pending.then(() => this.flush());
  }

  private async writeBatch(
    batch: Map<number, Blob>,
  ): Promise<void> {
    const generation = this.generation;
    let transaction: IDBTransaction | undefined;
    let done: Promise<void> | undefined;
    try {
      transaction = this.database().transaction(
        "chunks",
        "readwrite",
      );
      this.flushTransaction = transaction;
      done = transactionDone(transaction);
      const store = transaction.objectStore("chunks");
      for (const [chunkIndex, data] of batch)
        store.put({ chunkIndex, data });
      const [chunkCount, last] = await Promise.all([
        requestResult(store.count()),
        requestResult(store.openKeyCursor(null, "prev")),
        done,
      ]);
      this.assertGeneration(generation);
      if (this.info) {
        this.info = {
          ...this.info,
          chunkCount,
          cachedBytes: cachedBytes(
            this.info,
            chunkCount,
            last?.key,
          ),
        };
        this.dispatchEvent("update", this.info);
      }
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        /* Already settled. */
      }
      await done?.catch(() => {});
      if (generation === this.generation && this.db) {
        for (const [index, data] of batch)
          if (!this.memoryCache.has(index))
            this.memoryCache.set(index, data);
      }
      throw transaction?.error ?? error;
    } finally {
      if (this.flushTransaction === transaction)
        this.flushTransaction = null;
    }
  }

  public async storeChunk(
    chunkIndex: number,
    data: ArrayBufferLike,
  ): Promise<void> {
    this.database();
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0)
      throw new Error("Invalid chunk index");
    // Late duplicate frames must not repopulate chunks after the final clear.
    // If an early getFile() fails because chunks are missing, receipt can resume.
    if (this.mergePromise)
      await this.mergePromise.catch(() => {});
    this.database();
    if (this.info?.file) return;
    if (
      this.info?.chunkSize &&
      data.byteLength !==
        expectedChunkSize(this.info, chunkIndex)
    )
      throw new Error(
        `Invalid byte length for chunk ${chunkIndex}`,
      );
    const buffer =
      data instanceof ArrayBuffer
        ? data
        : new Uint8Array(data).slice().buffer;
    this.memoryCache.set(chunkIndex, new Blob([buffer]));
    if (this.memoryCache.size >= this.maxMomeryCacheSize)
      await this.flush();
  }

  public async getChunk(
    chunkIndex: number,
  ): Promise<ArrayBuffer | null> {
    await this.flush();

    // A locally selected File is immutable for the lifetime of this
    // cache and can be read without hitting IndexedDB for every chunk.
    // Received/cached chunks still refresh metadata from IndexedDB.
    const cachedInfo = this.info;
    if (cachedInfo?.file && cachedInfo.chunkSize) {
      const start = chunkIndex * cachedInfo.chunkSize;
      const end = Math.min(
        start + cachedInfo.chunkSize,
        cachedInfo.file.size,
      );
      return await cachedInfo.file
        .slice(start, end)
        .arrayBuffer();
    }

    const info = await this.getInfo();
    if (!info) {
      throw new Error("info is not found");
    }
    if (!info.chunkSize) {
      throw new Error("chunkSize is not found");
    }
    const file = info.file;
    if (file) {
      // Send specific data blocks
      const start = chunkIndex * info.chunkSize;
      const end = Math.min(
        start + info.chunkSize,
        file.size,
      );
      const chunk = file.slice(start, end);
      return await chunk.arrayBuffer();
    } else {
      const store = await this.getChunkStore("readonly");
      const request = store.get(chunkIndex);
      const record = await requestResult<
        StoredChunk | undefined
      >(request);
      if (!record) return null;
      return record.data instanceof Blob
        ? record.data.arrayBuffer()
        : record.data;
    }
  }

  async getChunkCount(): Promise<number> {
    await this.flush();
    const store = await this.getChunkStore("readonly");
    const countRequest = store.count();
    return new Promise((resolve, reject) => {
      countRequest.onsuccess = () => {
        resolve(countRequest.result);
      };
      countRequest.onerror = () => {
        reject(countRequest.error);
      };
    });
  }

  cleanup(): Promise<void> {
    if (this.isRetained()) return Promise.resolve();
    if (this.cleanupPromise) return this.cleanupPromise;
    this.generation++;
    this.cancelMerge?.(
      new DOMException(
        "Cache deleted during assembly",
        "AbortError",
      ),
    );
    try {
      this.flushTransaction?.abort();
    } catch {
      /* Already settled. */
    }
    this.memoryCache.clear();
    this.info = null;
    this.db?.close();
    this.db = null;
    const pending = new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(
        `${DBNAME_PREFIX}${this.id}`,
      );
      request.onsuccess = () => {
        this.dispatchEvent("cleanup", undefined);
        resolve();
      };
      request.onerror = () => reject(request.error);
      // A blocked delete has NOT succeeded. Existing connections receive
      // versionchange and close; only onsuccess reports cleanup complete.
      request.onblocked = () =>
        console.warn(
          `Cache ${this.id} deletion blocked by another connection`,
        );
    }).finally(() => {
      if (this.cleanupPromise === pending)
        this.cleanupPromise = null;
    });
    this.cleanupPromise = pending;
    return pending;
  }

  getFile(): Promise<File | null> {
    return this.mergeFile();
  }

  mergeFile(): Promise<File | null> {
    if (this.mergePromise) return this.mergePromise;
    const generation = this.generation;
    const pending = this.performMerge(generation).finally(
      () => {
        if (this.mergePromise !== pending) return;
        this.mergePromise = null;
        this.isMerging = false;
        if (this.info && generation === this.generation) {
          this.info = { ...this.info, isMerging: false };
          this.dispatchEvent("update", this.info);
        }
      },
    );
    this.mergePromise = pending;
    return pending;
  }

  private async performMerge(
    generation: number,
  ): Promise<File | null> {
    await this.flush();
    this.assertGeneration(generation);
    const info = await this.getInfo();
    this.assertGeneration(generation);
    if (!info || info.file) return info?.file ?? null;
    this.isMerging = true;
    this.metrics = null;
    this.info = { ...info, isMerging: true };
    this.dispatchEvent("merging", undefined);
    this.dispatchEvent("update", this.info);
    this.assertGeneration(generation);
    const result = await new Promise<MergeResult>(
      (resolve, reject) => {
        const worker = this.createMergeWorker();
        let settled = false;
        const finish = (
          error?: Error,
          value?: MergeResult,
        ) => {
          if (settled) return;
          settled = true;
          worker.onmessage = null;
          worker.onerror = null;
          worker.onmessageerror = null;
          worker.terminate();
          if (this.cancelMerge === cancel)
            this.cancelMerge = undefined;
          if (error) reject(error);
          else resolve(value!);
        };
        const cancel = (error: Error) => finish(error);
        this.cancelMerge = cancel;
        worker.onmessage = (
          event: MessageEvent<{
            result?: MergeResult;
            error?: { name?: string; message: string };
          }>,
        ) => {
          if (event.data.error) {
            const error = new Error(
              event.data.error.message,
            );
            error.name = event.data.error.name ?? "Error";
            finish(error);
          } else if (event.data.result)
            finish(undefined, event.data.result);
          else
            finish(
              new Error("Invalid merge worker response"),
            );
        };
        worker.onerror = (event) => {
          event.preventDefault();
          finish(
            new Error(
              event.message || "Merge worker failed",
            ),
          );
        };
        worker.onmessageerror = () =>
          finish(
            new Error(
              "Cannot decode merge worker response",
            ),
          );
        try {
          worker.postMessage({ fileId: this.id });
        } catch (error) {
          finish(
            error instanceof Error
              ? error
              : new Error(String(error)),
          );
        }
      },
    );
    this.assertGeneration(generation);
    this.metrics = result.metrics;
    this.isMerging = false;
    this.info = result.info
      ? {
          ...result.info,
          isComplete: !!result.info.file,
          isMerging: false,
          chunkCount: result.info.file
            ? 0
            : info.chunkCount,
          cachedBytes: result.info.file
            ? result.info.fileSize
            : info.cachedBytes,
        }
      : null;
    this.dispatchEvent("update", this.info);
    const file = result.info?.file ?? null;
    // Worker already committed info.put(file) + chunks.clear(). No second write.
    if (file && result.assembled)
      this.dispatchEvent("complete", file);
    return file;
  }
}
