import { DBNAME_PREFIX } from "@/constants";
import type {
  ChunkCache,
  FileMetaData,
} from "@/libs/domain/file";
import type { FileID } from "@/libs/domain/ids";
import { IDBChunkCache } from "@/libs/infrastructure/storage/indexeddb-chunk-cache";
import type { Accessor } from "solid-js";
import { v4 } from "uuid";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

import { FileCatalogIndex } from "./file-catalog-index";

export class FileCacheFactory {
  readonly catalog = new FileCatalogIndex();
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
      this.catalog.update(id, ev.detail);
      if (ev.detail) {
        setAppState("cache", "cacheInfo", id, ev.detail);
      }
    });

    cache.addEventListener("cleanup", () => {
      this.catalog.update(id, null);
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
