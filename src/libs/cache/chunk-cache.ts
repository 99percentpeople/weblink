import { Accessor, createSignal, Setter } from "solid-js";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import { appOptions } from "../core/store";
import { formatBtyeSize } from "../utils/format-filesize";
import { ChunkRange, getSubRanges } from "../utils/range";

export interface ChunkMetaData {
  id: string;
  fileName: string;
  fileSize: number;
  lastModified?: number;
  mimetype?: string;
  chunkSize: number;
}

export interface FileMetaData extends ChunkMetaData {
  file?: File;
}

export type ChunkCacheEventMap = {
  cleanup: void;
  merged: void;
  merging: void;
};

export interface ChunkCache {
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

  readonly id: string;

  info: Accessor<FileMetaData | null>;

  storeChunk(
    chunckIndex: number,
    data: ArrayBufferLike,
  ): Promise<void>;
  setInfo(data: FileMetaData): Promise<void>;
  getInfo(): Promise<FileMetaData | null>;
  getChunk(chunkIndex: number): Promise<ArrayBuffer | null>;
  getChunkCount(): Promise<number>;
  getReqRanges(): Promise<ChunkRange[] | null>;
  getFile(): Promise<File | null>;
  flush(): Promise<void>;
  cleanup(): Promise<void>;
  calcCachedBytes(): Promise<number | null>;
  getCachedKeys(): Promise<number[]>;
  isDone(): Promise<boolean>;
}

export interface IDBChunkCacheOptions {
  id: string;
}

export class IDBChunkCache implements ChunkCache {
  static DBNAME_PREFIX: string = "file-";
  info: Accessor<FileMetaData | null>;
  // private chunkStore?: IDBObjectStore;
  // private infoStore?: IDBObjectStore;
  private infoSetter: Setter<FileMetaData | null>;
  private db: Promise<IDBDatabase> | IDBDatabase;
  private status: "storing" | "merging" | "done" | "error" =
    "storing";

  private eventEmitter =
    new MultiEventEmitter<ChunkCacheEventMap>();
  public readonly id: string;
  private memoryCache: Array<[number, ArrayBufferLike]> =
    []; // 内存缓存

  private maxMomeryCacheSize: number =
    appOptions.maxMomeryCacheSlices;
  constructor(options: IDBChunkCacheOptions) {
    this.id = options.id;

    const [info, setInfo] =
      createSignal<FileMetaData | null>(null);

    this.info = info;
    this.infoSetter = setInfo;

    this.db = this.initDB();
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
    const totalLength = Math.ceil(
      info.fileSize / info.chunkSize,
    );

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
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(
        `${IDBChunkCache.DBNAME_PREFIX}${this.id}`,
      );

      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("info", {
          keyPath: "id",
        });
        db.createObjectStore(this.id, {
          keyPath: "chunkIndex",
        });
      };

      request.onsuccess = async () => {
        const db = request.result;
        resolve(db);
        const done = await this.isDone();
        this.isEmpty();
        const info = await this.getInfo();

        if (done) {
          if (info?.file) {
            this.status = "done";
          }
        }
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  }

  async isEmpty() {
    const info = await this.getInfo();
    const count = await this.getChunkCount();
    let empty = true;
    if (!info && count === 0) {
      empty = false;
    }

    return empty;
  }

  async isDone() {
    let done = false;

    const info = await this.getInfo();
    end: if (info) {
      if (info.file) {
        done = true;
        break end;
      }
      const count = await this.getChunkCount();
      const total = Math.ceil(
        info.fileSize / info.chunkSize,
      );

      console.log(
        `check done total:${total} count:${count}`,
      );

      if (total === count) {
        done = true;
      }
    }

    return done;
  }

  private async getChunkStore(mode?: IDBTransactionMode) {
    const db = await this.db;
    const transaction = db.transaction(this.id, mode);

    const store = transaction.objectStore(this.id);

    return store;
  }

  private async getInfoStore(mode?: IDBTransactionMode) {
    const db = await this.db;
    const transaction = db.transaction("info", mode);
    const store = transaction.objectStore("info");
    return store;
  }

  public async setInfo(data: FileMetaData): Promise<void> {
    this.infoSetter(data);
    const store = await this.getInfoStore("readwrite");
    const request = store.put(data);
    return new Promise(async (resolve, reject) => {
      request.onsuccess = () => {
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  public async getInfo(): Promise<FileMetaData | null> {
    const store = await this.getInfoStore("readonly");
    const request = store.get(this.id);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const info = request.result ?? null;
        this.infoSetter(info);
        resolve(info);
      };
      request.onerror = () => reject(request.error);
    });
  }

  // 将内存缓存批量写入到数据库
  async flush() {
    if (this.memoryCache.length === 0) return;

    const store = await this.getChunkStore("readwrite");
    const transaction = store.transaction;

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
    const info = this.info();
    const file = info?.file;
    if (info && file) {
      // 发送特定的数据块
      const start = chunkIndex * info.chunkSize;
      const end = Math.min(
        start + info.chunkSize,
        file.size,
      );
      const chunk = file.slice(start, end);

      const reader = new FileReader();

      return new Promise((reslove, reject) => {
        reader.onload = () => {
          if (reader.result) {
            // 构造包含块编号和数据的 ArrayBuffer
            const chunkData = reader.result as ArrayBuffer;
            reslove(chunkData);
          }
        };
        reader.onerror = reject;
        reader.readAsArrayBuffer(chunk);
      });
    }

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
    const db = await this.db;
    const dbName = db.name;
    db.close(); // 关闭数据库连接
    const request = indexedDB.deleteDatabase(dbName);
    await new Promise<void>((resolve, reject) => {
      request.onsuccess = () => {
        console.log(
          `Database ${dbName} deleted successfully.`,
        );

        this.infoSetter(null);
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
      };
    });
  }

  async getFile(): Promise<File | null> {
    await this.flush();
    if (this.status === "merging") {
      console.warn(`cache is ${this.status} already`);
      return null;
    }

    const info = await this.getInfo();
    if (!info) {
      throw new Error(
        "can not get file, file info is empty",
      );
    }
    if (info.file) {
      return info.file;
    }
    const done = await this.isDone();
    if (!done) {
      console.error(`transmissin is not done`);
      return null;
    }

    this.dispatchEvent("merging", undefined);
    this.status = "merging";

    const store = await this.getChunkStore("readwrite");

    const limit = 128 * 1024 * 1024;
    if (info.fileSize <= limit) {
      console.log(
        `file size lower than ${formatBtyeSize(limit)}, use getAll to merge chunks`,
      );

      const request = store.getAll();
      return await new Promise<File>((reslove, reject) => {
        request.onsuccess = () => {
          const blobParts: BlobPart[] = request.result.map(
            (res) => new Blob([res.data as ArrayBuffer]),
          );

          const file = new File(blobParts, info.fileName, {
            type: info.mimetype,
            lastModified: info.lastModified,
          });
          info.file = file;

          this.setInfo(info);
          store.clear();

          reslove(file);
          this.status = "done";
          this.dispatchEvent("merged", undefined);
        };

        request.onerror = (err) => reject(err);
      });
    } else {
      console.log(
        `file size larger than ${formatBtyeSize(limit)}, use cursor to merge chunks`,
      );
      const blobParts: BlobPart[] = [];
      const request = store.openCursor();

      return await new Promise<File>((reslove, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) {
            blobParts.push(
              new Blob([cursor.value.data as ArrayBuffer]),
            );
            cursor.continue();
          } else {
            const file = new File(
              blobParts,
              info.fileName,
              {
                type: info.mimetype,
                lastModified: info.lastModified,
              },
            );
            info.file = file;

            this.setInfo(info);
            store.clear();
            reslove(file);
            this.status = "done";
            this.dispatchEvent("merged", undefined);
          }
        };

        request.onerror = (err) => reject(err);
      });
    }
  }
}
