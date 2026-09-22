import {
  ChunkCache,
  IDBChunkCache,
} from "@/libs/cache/chunk-cache";
import type { FileID } from "@/libs/core/ids";
import type { Accessor } from "solid-js";
import {
  ChunkCacheInfo,
  DBNAME_PREFIX,
  FileMetaData,
} from "@/libs/cache";
import { v4 } from "uuid";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

export class FileCacheFactory {
  status: Accessor<"ready" | "loading"> = () =>
    appState.cache.status;
  readonly cacheInfo: Record<FileID, FileMetaData> =
    appState.cache.cacheInfo;
  readonly caches: Record<FileID, ChunkCache> =
    appState.cache.caches;

  async initialize() {
    try {
      const databases = await indexedDB.databases();

      const fileDBs = databases
        .filter((db) => db.name?.startsWith(DBNAME_PREFIX))
        .map((db) =>
          db.name!.substring(DBNAME_PREFIX.length),
        );

      const caches = await Promise.all(
        fileDBs.map((id) => this.loadCache(id)),
      );

      for (const cache of caches) {
        this.addCache(cache.id, cache);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setAppState("cache", "status", "ready");
    }
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
      setAppState("cache", "caches", id, undefined!);
    }
    return;
  }

  private async loadCache(id: FileID): Promise<ChunkCache> {
    if (this.caches[id]) {
      return this.caches[id];
    }

    const cache = new IDBChunkCache({
      id,
      maxMomeryCacheSize:
        appState.options.maxMomeryCacheSlices,
    });

    cache.addEventListener("update", (ev) => {
      if (ev.detail) {
        setAppState("cache", "cacheInfo", id, ev.detail);
      }
    });

    cache.addEventListener("cleanup", () => {
      setAppState("cache", "cacheInfo", id, undefined!);
      setAppState("cache", "caches", id, undefined!);
    });

    cache.addEventListener("complete", (ev) => {
      if (appState.options.automaticDownload) {
        const file = ev.detail;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(file);
        a.download = file.name;
        a.click();
      }
    });
    await cache.initialize();

    return cache;
  }

  private async addCache(id: FileID, cache: ChunkCache) {
    setAppState("cache", "caches", id, cache);
  }

  async getStorages(
    options: {
      includeIncomplete?: boolean;
    } = {},
  ): Promise<ChunkCacheInfo[] | null> {
    const includeIncomplete =
      options.includeIncomplete ?? false;

    return Promise.all(
      Object.values(this.caches).map((cache) =>
        cache.getInfo(),
      ),
    ).then((infos) => {
      return infos
        .filter((info): info is FileMetaData => {
          if (!info) return false;
          if (includeIncomplete) return true;
          return Boolean(info.isComplete);
        })
        .map((info) => {
          const { file, ...rest } = info;
          return rest;
        }) as ChunkCacheInfo[];
    });
  }

  async createCache(id?: FileID): Promise<ChunkCache> {
    const cacheId = id ?? v4();
    const cache = await this.loadCache(cacheId);
    this.addCache(cacheId, cache);
    return cache;
  }
}

export let cacheManager: FileCacheFactory;

export function createCacheManager() {
  if (!cacheManager) {
    cacheManager = new FileCacheFactory();
  }
  return cacheManager;
}
