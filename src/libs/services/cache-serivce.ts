import { isServer } from "solid-js/web";
import {
  ChunkCache,
  IDBChunkCache,
} from "../cache/chunk-cache";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import {
  createStore,
  SetStoreFunction,
} from "solid-js/store";
import { FileID } from "../core/type";
import { Accessor, createSignal, Setter } from "solid-js";

type EventMap = {
  update: string;
  cleanup: string;
};

class FileCacheFactory {
  status: Accessor<"ready" | "loading">;
  private setStatus: Setter<"ready" | "loading">;
  private eventEmitter: MultiEventEmitter<EventMap> =
    new MultiEventEmitter();

  readonly caches: Record<FileID, ChunkCache>;
  private setCaches: SetStoreFunction<
    Record<FileID, ChunkCache>
  >;
  constructor() {
    const [caches, setCaches] =
      createStore<Record<FileID, ChunkCache>>();
    this.caches = caches;
    this.setCaches = setCaches;
    this.update();
    const [status, setStatus] = createSignal<
      "ready" | "loading"
    >("loading");
    this.status = status;
    this.setStatus = setStatus;
  }

  addEventListener<K extends keyof EventMap>(
    eventName: K,
    handler: EventHandler<EventMap[K]>,
  ) {
    return this.eventEmitter.addEventListener(
      eventName,
      handler,
    );
  }

  removeEventListener<K extends keyof EventMap>(
    eventName: K,
    handler: EventHandler<EventMap[K]>,
  ) {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
    );
  }

  private dispatchEvent<K extends keyof EventMap>(
    eventName: K,
    event: EventMap[K],
  ) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  async update() {
    if (isServer) return;
    const databases = await indexedDB.databases();

    for (const db of databases) {
      if (
        db.name?.startsWith(IDBChunkCache.DBNAME_PREFIX)
      ) {
        const id = db.name.substring(
          IDBChunkCache.DBNAME_PREFIX.length,
        );
        this.createCache(id);
      }
    }
    this.setStatus("ready");
  }

  getCache(id: FileID): ChunkCache | null {
    if (this.caches[id]) {
      return this.caches[id];
    }
    return null;
  }

  async remove(id: FileID) {
    const cache = this.caches[id];
    if (cache) {
      await cache.cleanup();
      this.setCaches(id, undefined!);
    }
    return;
  }

  createCache(id: FileID): ChunkCache {
    if (this.caches[id]) {
      console.warn(`cache ${id} has already created`);
      return this.caches[id];
    }

    const cache = new IDBChunkCache({
      id,
    });
    cache.addEventListener(
      "cleanup",
      () => {
        this.setCaches(id, undefined!);
        this.dispatchEvent("cleanup", id);
      },
      { once: true },
    );
    this.setCaches(id, cache);
    this.dispatchEvent("update", id);
    return cache;
  }
}

export const cacheManager = new FileCacheFactory();
