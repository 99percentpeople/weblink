import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import { ChunkRange, getSubRanges } from "../utils/range";
import MergeChunkWorker from "@/libs/workers/merge-chunk?worker";
import {
  ChunkCacheEventMap,
  ChunkMetaData,
  DBNAME_PREFIX,
  FileMetaData,
} from ".";

export interface ChunkCache {
  readonly id: string;
  addEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof ChunkCacheEventMap>(
    eventName: K,
    handler: EventHandler<ChunkCacheEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void;

  initialize(): Promise<void>;
  storeChunk(
    chunckIndex: number,
    data: ArrayBufferLike,
  ): Promise<void>;
  setInfo(data: Omit<ChunkMetaData, "id">): Promise<void>;
  getInfo(): Promise<FileMetaData | null>;
  getChunk(chunkIndex: number): Promise<ArrayBuffer | null>;
  getChunkCount(): Promise<number>;
  getReqRanges(): Promise<ChunkRange[] | null>;
  getFile(): Promise<File | null>;
  flush(): Promise<void>;
  cleanup(): Promise<void>;
  calcCachedBytes(): Promise<number | null>;
  getCachedKeys(): Promise<number[]>;
  isTransferComplete(): Promise<boolean>;
  mergeFile(): Promise<File | null>;
}

export interface IDBChunkCacheOptions {
  id: string;
  maxMomeryCacheSize: number;
}

export class IDBChunkCache implements ChunkCache {
  private db: IDBDatabase | null = null;
  private isMerging = false;
  private eventEmitter =
    new MultiEventEmitter<ChunkCacheEventMap>();
  public readonly id: string;
  private info: FileMetaData | null = null;
  // memory cache
  private memoryCache: Array<[number, ArrayBufferLike]> =
    [];

  private maxMomeryCacheSize: number;
  constructor(options: IDBChunkCacheOptions) {
    this.id = options.id;
    this.maxMomeryCacheSize = options.maxMomeryCacheSize;
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
    if (!info) {
      return null;
    }
    if (!info.chunkSize) {
      return null;
    }
    const totalLength = getTotalChunkCount(info);

    const hasLast = async () => {
      const lastKey = totalLength - 1;
      const store = await this.getChunkStore();
      const request = store.getKey(lastKey);
      return new Promise<boolean>((reslove, reject) => {
        request.onsuccess = () => {
          reslove(request.result !== undefined);
        };
        request.onerror = () => reject(request.error);
      });
    };

    const count = await this.getChunkCount();

    let bytes = count * info.chunkSize;

    if (await hasLast()) {
      const remainSize = info.fileSize % info.chunkSize;
      bytes = bytes - info.chunkSize + remainSize;
    }
    return bytes;
  }

  async getCachedKeys() {
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

  private async getInfoStore(mode?: IDBTransactionMode) {
    const db = this.db;
    if (!db) {
      throw new Error("db is not initialized");
    }
    const transaction = db.transaction("info", mode);
    const store = transaction.objectStore("info");
    return store;
  }

  public async setInfo(data: ChunkMetaData): Promise<void> {
    const setData = {
      ...data,
      id: this.id,
    };
    const store = await this.getInfoStore("readwrite");
    const request = store.put(setData);
    return new Promise((resolve, reject) => {
      request.onsuccess = async () => {
        resolve();
        this.info = {
          ...setData,
          isComplete: await isComplete(setData),
          chunkCount: await this.getChunkCount(),
          isMerging: this.isMerging,
        };
        this.dispatchEvent("update", this.info);
      };
      request.onerror = () => reject(request.error);
    });
  }

  public async getInfo(): Promise<FileMetaData | null> {
    const store = await this.getInfoStore("readonly");
    const request = store.get(this.id);
    const dbinfo = await new Promise<ChunkMetaData | null>(
      (resolve, reject) => {
        request.onsuccess = async () => {
          const info = request.result ?? null;
          resolve(info);
        };
        request.onerror = () => reject(request.error);
      },
    );

    if (!dbinfo) {
      console.warn(`info is not found for ${this.id}`);
      return null;
    }

    this.info = {
      ...dbinfo,
      isComplete: await isComplete(dbinfo),
      chunkCount: await this.getChunkCount(),
      isMerging: this.isMerging,
    };

    return this.info;
  }

  // flush memory cache to db
  async flush() {
    if (this.memoryCache.length === 0) return;

    const store = await this.getChunkStore("readwrite");
    const transaction = store.transaction;

    const memoryCount = this.memoryCache.length;
    for (
      let value = this.memoryCache.pop();
      value;
      value = this.memoryCache.pop()
    ) {
      const [chunkIndex, data] = value;
      store.put({ chunkIndex, data });
    }

    return new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => {
        resolve();
        if (this.info) {
          if (!this.info.chunkCount) {
            this.info.chunkCount = 0;
          }
          this.info.chunkCount += memoryCount;
          this.dispatchEvent("update", this.info);
        }
      };
      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  public async storeChunk(
    chunkIndex: number,
    data: ArrayBufferLike,
  ): Promise<void> {
    this.memoryCache.push([chunkIndex, data]);

    if (
      this.memoryCache.length >= this.maxMomeryCacheSize
    ) {
      await this.flush();
    }
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
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          resolve(
            request.result ? request.result.data : null,
          );
        };
        request.onerror = () => reject(request.error);
      });
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

  public async cleanup(): Promise<void> {
    const db = this.db;
    if (!db) {
      throw new Error("db is not initialized");
    }
    const dbName = db.name;
    db.close();
    const request = indexedDB.deleteDatabase(dbName);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        console.log(
          `Database ${dbName} deleted successfully.`,
        );
        this.dispatchEvent("cleanup", undefined);
        resolve();
      };
      request.onerror = (event) => {
        console.error(
          `Failed to delete database ${dbName}.`,
          event,
        );
        reject(event);
      };
      request.onblocked = () => {
        console.warn(`Database deletion blocked.`);
        this.dispatchEvent("cleanup", undefined);
        resolve();
      };
    });
  }

  async getFile(): Promise<File | null> {
    await this.flush();

    const info = await this.getInfo();
    if (!info) {
      console.warn("info is not found");
      return null;
    }
    if (info.file) {
      return info.file;
    }
    return await this.mergeFile();
  }

  async mergeFile() {
    await this.flush();

    if (this.isMerging) {
      console.warn(`cache is merging already`);
      return null;
    }
    this.isMerging = true;
    const info = await this.getInfo();

    if (!info) {
      console.warn("info is not found");
      return null;
    }

    this.dispatchEvent("merging", undefined);
    this.dispatchEvent("update", this.info);

    const isWorker =
      typeof WorkerGlobalScope !== "undefined" &&
      self instanceof WorkerGlobalScope;
    if (!isWorker) {
      // use worker to merge chunks
      const worker = new MergeChunkWorker();

      return await new Promise<File | null>(
        (resolve, reject) => {
          this.isMerging = true;
          worker.onmessage = (event) => {
            const { data, error } = event.data;
            if (error) {
              console.error(error);
              reject(error);
              return;
            }
            info.file = data as File;
            this.setInfo(info);
            resolve(data as File);

            this.dispatchEvent("complete", data);
          };
          worker.postMessage({ fileId: this.id });
        },
      ).finally(() => {
        this.isMerging = false;
        worker.terminate();
      });
    }

    // current scope is worker
    const store = await this.getChunkStore("readwrite");
    const blobParts: BlobPart[] = [];
    const request = store.openCursor();

    const logString = `merge file ${info.fileName} ${info.fileSize} bytes`;
    console.time(logString);
    return await new Promise<File>((reslove, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          blobParts.push(
            new Blob([cursor.value.data as ArrayBuffer]),
          );
          cursor.continue();
        } else {
          const file = new File(blobParts, info.fileName, {
            type: info.mimetype,
            lastModified: info.lastModified,
          });
          info.file = file;

          this.setInfo(info);
          store.clear();
          reslove(file);
          this.dispatchEvent("complete", file);
          this.dispatchEvent("update", info);
        }
      };

      request.onerror = (err) => reject(err);
    }).finally(() => {
      this.isMerging = false;
      console.timeEnd(logString);
    });
  }
}

async function isComplete(info: FileMetaData) {
  let done = false;

  if (info) {
    done = !!info.file;
  }
  return done;
}

export function getTotalChunkCount(info: FileMetaData) {
  if (!info.chunkSize) {
    throw new Error("chunkSize is not found");
  }
  return Math.ceil(info.fileSize / info.chunkSize);
}
