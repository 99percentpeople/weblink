import { DBNAME_PREFIX } from "@/constants";
import type {
  ChunkCache,
  FileMetaData,
} from "@/libs/domain/file";
import type { FileID } from "@/libs/domain/ids";
import { IDBChunkCache } from "@/libs/infrastructure/storage/indexeddb-chunk-cache";
import type { Accessor } from "solid-js";
import { v4 } from "uuid";
import { FileFingerprintService } from "./file-fingerprint-service";
import { FileLibraryService } from "./file-library-service";
import { IndexedDbFileLibrary } from "@/libs/infrastructure/storage/indexeddb-file-library";
import { downloadFile } from "@/libs/utils/download-file";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

import { FileCatalogIndex } from "./file-catalog-index";

export class FileCacheFactory {
  readonly catalog = new FileCatalogIndex();
  private readonly rawCaches = new Map<
    string,
    Promise<ChunkCache>
  >();
  private readonly retired = new Set<ChunkCache>();
  private retirementTimer?: ReturnType<typeof setTimeout>;
  isCacheInUse: (cache: ChunkCache) => boolean = () =>
    false;
  private readonly fingerprints =
    new FileFingerprintService();
  readonly preparations = this.fingerprints.tasks;
  clearPreparations = this.fingerprints.clearFinished;
  readonly library = new FileLibraryService({
    repository: new IndexedDbFileLibrary(),
    getChunkSize: () => appState.options.chunkSize,
    fingerprint: (file, options) =>
      this.fingerprints.hash(file, options),
    storage: (id) => this.loadStorage(id),
    getCache: (id) => this.getCache(id),
    publish: async (cache) => {
      const previous = this.getCache(cache.id);
      this.observe(cache);
      this.addCache(cache.id, cache);
      await cache.initialize();
      if (
        previous &&
        previous !== cache &&
        !this.library.ownsStorage(previous.id)
      ) {
        this.retired.add(previous);
        this.collectRetiredStorage();
      }
    },
  });
  status: Accessor<"ready" | "loading"> = () =>
    appState.cache.status;
  readonly cacheInfo: Record<FileID, FileMetaData> =
    appState.cache.cacheInfo;
  readonly caches: Record<FileID, ChunkCache> =
    appState.cache.caches;

  async initialize() {
    setAppState("cache", "status", "loading");
    setAppState("cache", "error", undefined);
    try {
      await this.library.initialize();
      const databases = await indexedDB.databases();

      const fileDBs = databases
        .filter((db) => db.name?.startsWith(DBNAME_PREFIX))
        .map((db) =>
          db.name!.substring(DBNAME_PREFIX.length),
        );

      const caches = await Promise.all(
        fileDBs.map((id) => this.loadStorage(id)),
      );

      for (const cache of caches) {
        const info = await cache
          .getInfo()
          .catch(() => null);
        if (
          info?.contentStorage ||
          this.library.ownsStorage(cache.id) ||
          this.caches[cache.id]
        )
          continue;
        this.observe(cache);
        this.addCache(cache.id, cache);
        if (info) {
          const visible =
            info.fingerprint &&
            !info.contentKey &&
            info.file
              ? {
                  ...info,
                  file: undefined,
                  isComplete: false,
                }
              : info;
          this.catalog.update(cache.id, visible);
          setAppState(
            "cache",
            "cacheInfo",
            cache.id,
            visible,
          );
        }
      }
    } catch (e) {
      setAppState(
        "cache",
        "error",
        e instanceof Error ? e.message : String(e),
      );
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
    await this.library.removeFile(id);
  }

  private loadStorage(id: FileID): Promise<ChunkCache> {
    const existing = this.rawCaches.get(id);
    if (existing) return existing;
    const cache: ChunkCache = new IDBChunkCache({
      id,
      maxMomeryCacheSize:
        appState.options.maxMomeryCacheSlices,
      isRetained: () => this.library.ownsStorage(id),
    });
    this.attachVerification(cache);
    cache.addEventListener("cleanup", () =>
      this.rawCaches.delete(id),
    );
    const pending = cache
      .initialize()
      .then(() => cache)
      .catch((error) => {
        this.rawCaches.delete(id);
        throw error;
      });
    this.rawCaches.set(id, pending);
    return pending;
  }

  private observe(cache: ChunkCache): void {
    const id = cache.id;
    cache.addEventListener("update", (ev) => {
      if (this.caches[id] !== cache) return;
      // Fingerprinted receives are not previewable/advertised until verification.
      const info =
        ev.detail?.fingerprint &&
        !ev.detail.contentKey &&
        ev.detail.file
          ? {
              ...ev.detail,
              file: undefined,
              isComplete: false,
              isMerging: true,
            }
          : ev.detail;
      this.catalog.update(id, info);
      if (info) {
        setAppState("cache", "cacheInfo", id, info);
      }
    });

    cache.addEventListener("cleanup", () => {
      if (this.caches[id] !== cache) return;
      this.catalog.update(id, null);
      setAppState("cache", "cacheInfo", id, undefined!);
      setAppState("cache", "caches", id, undefined!);
    });
  }

  private async addCache(id: FileID, cache: ChunkCache) {
    setAppState("cache", "caches", id, cache);
  }

  private collectRetiredStorage(): void {
    clearTimeout(this.retirementTimer);
    for (const cache of this.retired) {
      if (this.isCacheInUse(cache)) continue;
      this.retired.delete(cache);
      void cache.cleanup().catch(console.error);
    }
    if (this.retired.size)
      this.retirementTimer = setTimeout(
        () => this.collectRetiredStorage(),
        100,
      );
  }

  private attachVerification(cache: ChunkCache): void {
    let verified: Promise<File | null> | undefined;
    cache.verifyFile = (signal) =>
      (verified ??= (async () => {
        const file = await this.library.verifyReceived(
          cache,
          signal,
        );
        if (
          file &&
          !signal?.aborted &&
          appState.options.automaticDownload
        )
          downloadFile(file);
        return file;
      })().catch((error) => {
        verified = undefined;
        throw error;
      }));
    cache.retireReceiveStorage = async () => {
      if (
        !this.library.ownsStorage(cache.id) &&
        this.getCache(cache.id) !== cache
      )
        await cache.cleanup();
    };
  }

  async createCache(id?: FileID): Promise<ChunkCache> {
    const cacheId = id ?? v4();
    if (this.caches[cacheId]) return this.caches[cacheId];
    const cache = await this.loadStorage(cacheId);
    if (this.caches[cacheId]) return this.caches[cacheId];
    this.observe(cache);

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
