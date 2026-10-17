import { platform } from "@/libs/platform/runtime";
import { FileStorageService } from "./file-storage-service";
import type { FileStorage } from "@/libs/domain/file-storage";
import type { StoredFile } from "@weblink/platform";
import type {
  ChunkCache,
  FileMetaData,
} from "@/libs/domain/file";
import type { FileID } from "@/libs/domain/ids";
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
  constructor(
    readonly storage: FileStorage = new FileStorageService(
      platform.filesystem,
    ),
  ) {}
  private stopStorageWatch?: () => void;
  private stopLibraryWatch?: () => void;
  private readonly storageCaches =
    new WeakSet<ChunkCache>();
  private storageRefreshTimer?: ReturnType<
    typeof setTimeout
  >;
  private storageRefreshing?: Promise<void>;
  private storageRefreshRequested = false;
  private disposed = false;
  /** Ephemeral remote content transfers never enter the library or chat history. */
  async temporaryTransferCache(
    id: string,
  ): Promise<ChunkCache> {
    if (
      !/^remote-(?:clipboard|drop)_[a-zA-Z0-9-]+$/.test(id)
    )
      throw new Error(
        "Invalid temporary transfer cache id",
      );
    const cache = await this.storage.createCache(id, {
      memoryChunks: 16,
      isRetained: () => false,
    });
    await cache.initialize();
    return cache;
  }
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
    storage: (id, existingOnly) =>
      this.loadStorage(id, existingOnly),
    removeSource: (id) => this.storage.removeSource(id),
    getCache: (id) => this.getCache(id),
    publish: async (cache) => {
      if (this.disposed) return;
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
    this.stopLibraryWatch?.();
    this.stopLibraryWatch = this.library.onChange(() =>
      this.hideOwnedStorage(),
    );
    try {
      await this.storage.initialize();
      await this.library.initialize();
      const { files } = await this.storage.synchronize();

      const caches = await Promise.all(
        files.map((id) => this.loadStorage(id)),
      );

      for (const cache of caches) {
        if (/^remote-(clipboard|drop)_/.test(cache.id)) {
          await cache.cleanup();
          continue;
        }
        const info = await cache
          .getInfo()
          .catch(() => null);
        if (
          (info?.contentStorage && !info.verifyContent) ||
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
      this.stopStorageWatch?.();
      this.stopStorageWatch = this.storage.onChange(() => {
        if (this.disposed || this.storageRefreshTimer)
          return;
        this.storageRefreshTimer = setTimeout(() => {
          this.storageRefreshTimer = undefined;
          void this.refreshStorage().catch((error) => {
            if (!this.disposed) console.error(error);
          });
        }, 300);
      });
      await this.refreshStorage().catch((error) => {
        if (!this.disposed) console.error(error);
      });
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

  private loadStorage(
    id: FileID,
    existingOnly = false,
  ): Promise<ChunkCache> {
    const existing = this.rawCaches.get(id);
    if (existing) return existing;
    const pending = this.storage
      .createCache(id, {
        existingOnly,
        memoryChunks: appState.options.maxMomeryCacheSlices,
        isRetained: () => this.library.ownsStorage(id),
      })
      .then(async (cache) => {
        this.storageCaches.add(cache);
        this.attachVerification(cache);
        cache.addEventListener(
          "cleanup",
          () =>
            this.rawCaches.get(id) === pending &&
            this.rawCaches.delete(id),
        );
        await cache.initialize();
        return cache;
      })
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
      if (this.disposed || this.caches[id] !== cache)
        return;
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
      } else
        setAppState("cache", "cacheInfo", id, undefined!);
    });

    cache.addEventListener("cleanup", () => {
      if (this.disposed || this.caches[id] !== cache)
        return;
      this.catalog.update(id, null);
      setAppState("cache", "cacheInfo", id, undefined!);
      setAppState("cache", "caches", id, undefined!);
    });
  }

  private async addCache(id: FileID, cache: ChunkCache) {
    setAppState("cache", "caches", id, cache);
  }

  private hideOwnedStorage(): void {
    if (this.disposed) return;
    for (const [id, cache] of Object.entries(this.caches)) {
      if (
        cache &&
        this.storageCaches.has(cache) &&
        this.library.ownsStorage(id)
      ) {
        // A scan can discover a newly committed file before its library reference
        // is published. Keep that raw cache for reads, but show only the reference.
        this.catalog.update(id, null);
        setAppState("cache", "cacheInfo", id, undefined!);
        setAppState("cache", "caches", id, undefined!);
      }
    }
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
    let verified: Promise<StoredFile | null> | undefined;
    cache.addEventListener("update", ({ detail }) => {
      if (detail?.storageUnavailable) verified = undefined;
    });
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
          downloadFile(file, { automatic: true });
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

  private refreshStorage(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.storageRefreshRequested = true;
    if (this.storageRefreshing)
      return this.storageRefreshing;
    const refresh = async () => {
      do {
        this.storageRefreshRequested = false;
        const snapshot = await this.storage.synchronize();
        if (this.disposed) return;
        for (const id of snapshot.removed) {
          // Release the local pin only. Sent/shared references still retain
          // their old content identity and become unavailable if the bytes changed.
          await this.library.releaseStoragePin(id);
          if (this.disposed) return;
          const cache = await this.rawCaches.get(id);
          // Finalization can replace a temporary storage identity. An active
          // receiver still needs its cache until verification and publication.
          if (cache && this.isCacheInUse(cache)) {
            this.retired.add(cache);
            this.collectRetiredStorage();
            continue;
          }
          await cache?.cleanup();
          if (this.disposed) return;
          if (this.caches[id] === cache) {
            this.catalog.update(id, null);
            setAppState(
              "cache",
              "cacheInfo",
              id,
              undefined!,
            );
            setAppState("cache", "caches", id, undefined!);
          }
        }
        for (const id of snapshot.files) {
          const cache = await this.loadStorage(id);
          if (this.disposed) return;
          // Internal deduplicated content is exposed through references only.
          // This rule applies to every provider, including cross-window imports.
          const info = await cache.getInfo();
          if (
            !this.caches[id] &&
            !this.library.ownsStorage(id) &&
            !(
              info?.contentStorage && !info.verifyContent
            ) &&
            !/^remote-(clipboard|drop)_/.test(id)
          ) {
            this.observe(cache);
            await this.addCache(id, cache);
          }
        }
        const caches = await Promise.allSettled(
          this.rawCaches.values(),
        );
        await Promise.all(
          caches.map(async (result) => {
            if (result.status === "fulfilled")
              await result.value.refresh?.();
          }),
        );
        if (!this.disposed)
          await this.library.reconcileMissingFiles();
        if (!this.disposed) await this.library.refresh();
      } while (
        this.storageRefreshRequested &&
        !this.disposed
      );
    };
    return (this.storageRefreshing = refresh().finally(
      () => {
        this.storageRefreshing = undefined;
      },
    ));
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.retirementTimer);
    clearTimeout(this.storageRefreshTimer);
    this.stopStorageWatch?.();
    this.stopLibraryWatch?.();
    for (const cache of this.rawCaches.values())
      void cache.then((value) => value.dispose?.());
    this.storage.dispose();
    this.library.dispose();
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

if (import.meta.hot)
  import.meta.hot.dispose(() => cacheManager?.dispose());
