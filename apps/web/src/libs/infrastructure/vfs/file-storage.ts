import type {
  FileStorage,
  FileStorageMount,
  FileStorageSnapshot,
  WritableStoredFile,
  StorageAuthorizationOptions,
} from "@/libs/domain/file-storage";
import type { ChunkCache } from "@/libs/domain/file";
import {
  StorageUnavailableError,
  type StoredFile,
  type VfsVolume,
} from "@/libs/domain/vfs";
import type { NativeFileSystem } from "@weblink/platform";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";
import { migrateLegacyIndexedDb } from "@/libs/infrastructure/storage/indexeddb-migration";
import {
  VfsDatabase,
  type StoredMount,
  type StoredVfsFile,
} from "@/libs/infrastructure/vfs/database";
import { IndexedDbVolume } from "@/libs/infrastructure/vfs/indexeddb-volume";
import { DirectoryVolume } from "@/libs/infrastructure/vfs/directory-volume";
import { VfsChunkCache } from "@/libs/infrastructure/vfs/chunk-cache";
import { scanDirectory } from "@/libs/infrastructure/vfs/directory-index";
import { DirectoryFileStore } from "@/libs/infrastructure/vfs/directory-file-store";
import { DirectoryVerification } from "@/libs/infrastructure/vfs/directory-verification";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import { WritableFileStore } from "./writable-file-store";
import { isHiddenDirectoryEntry } from "./directory-visibility";

export class FileStorageService implements FileStorage {
  private readonly volumes = new Map<string, VfsVolume>();
  migrationProgress?: StorageMigrationProgress;
  private readonly migrationListeners = new Set<
    (progress: StorageMigrationProgress) => void
  >();
  private readonly listeners = new Set<
    (mountId?: string) => void
  >();
  private readonly watches = new Map<string, () => void>();
  private initializing?: Promise<void>;
  private selected = "indexeddb";
  private disposed = false;
  private nativeError?: unknown;
  private readonly lifetime = new AbortController();
  private readonly directoryVerification =
    new DirectoryVerification();
  private readonly directoryFiles = new DirectoryFileStore(
    async (id) => {
      const volume = this.volumes.get(id);
      if (!volume)
        throw new StorageUnavailableError(
          "Storage directory is unavailable",
        );
      return volume;
    },
    this.directoryVerification,
  );
  private readonly directoryListing = new Map<
    string,
    string[]
  >();
  private readonly writableFiles: WritableFileStore;
  private directoriesAccessible = false;
  private scanning?: Promise<{
    files: string[];
    removed: string[];
  }>;
  constructor(
    private readonly native?: NativeFileSystem,
    readonly database = new VfsDatabase(),
  ) {
    this.writableFiles = new WritableFileStore(
      database,
      this.directoryFiles,
      this.directoryVerification,
      (id) => this.changed(id),
    );
  }
  async createWritableFile(
    options: Parameters<
      FileStorage["createWritableFile"]
    >[0],
  ): Promise<WritableStoredFile> {
    // Request permission before capture/encoding preparation can consume activation.
    const authorization = this.authorizeDefault({
      refresh: false,
    });
    await this.initialize();
    const mountId = this.selected;
    await authorization;
    if (this.disposed)
      throw new Error("File storage was closed");
    return this.writableFiles.create(
      await this.getVolume(mountId),
      options,
    );
  }
  get defaultMountId(): string {
    return this.selected;
  }
  get canMountDirectory(): boolean {
    return (
      !!this.native ||
      (typeof window !== "undefined" &&
        typeof window.showDirectoryPicker === "function")
    );
  }
  mounts(): FileStorageMount[] {
    return [...this.volumes.values()].map(
      ({ id, name, kind }) => ({
        id,
        name,
        kind,
        canOpen: kind === "native" && !!this.native,
      }),
    );
  }
  async openDirectory(id: string): Promise<void> {
    const volume = await this.getVolume(id);
    if (volume.kind !== "native" || !this.native)
      throw new StorageUnavailableError(
        "Opening this storage location is unavailable",
      );
    await this.native.openDirectory(id);
  }
  initialize(): Promise<void> {
    return (this.initializing ??= this.start().catch(
      (error) => {
        this.initializing = undefined;
        throw error;
      },
    ));
  }
  private async start(): Promise<void> {
    this.volumes.set(
      "indexeddb",
      new IndexedDbVolume(this.database),
    );
    for (const mount of await this.database.all<StoredMount>(
      "mounts",
    )) {
      if (mount.kind === "directory" && mount.handle)
        this.volumes.set(
          mount.id,
          new DirectoryVolume(
            mount.id,
            mount.name,
            mount.handle,
          ),
        );
    }
    if (this.native) {
      try {
        for (const volume of await this.native.volumes())
          this.volumes.set(volume.id, volume);
      } catch (error) {
        this.nativeError = error;
      }
    }
    // New desktop content goes to its native root; migrated caches stay in IndexedDB.
    this.selected =
      (await this.database.get<string>(
        "settings",
        "defaultMount",
      )) ?? (this.native ? "native-default" : "indexeddb");
    await migrateLegacyIndexedDb(
      this.database,
      this.lifetime.signal,
      (progress) => {
        this.migrationProgress = progress;
        this.migrationListeners.forEach((listener) =>
          listener(progress),
        );
      },
    );
    for (const volume of this.volumes.values())
      await this.observe(volume);
    await this.scanDirectories();
    this.changed();
  }
  private async observe(volume: VfsVolume): Promise<void> {
    this.watches.get(volume.id)?.();
    const stop = await volume.watch(() =>
      this.changed(volume.id),
    );
    if (this.disposed) stop();
    else this.watches.set(volume.id, stop);
  }
  async getVolume(id: string): Promise<VfsVolume> {
    await this.initialize();
    let volume = this.volumes.get(id);
    if (!volume) {
      const stored = await this.database.get<StoredMount>(
        "mounts",
        id,
      );
      if (stored?.handle) {
        volume = new DirectoryVolume(
          stored.id,
          stored.name,
          stored.handle,
        );
        this.volumes.set(id, volume);
        await this.observe(volume);
      } else if (this.native && id.startsWith("native-")) {
        try {
          for (const entry of await this.native.volumes()) {
            if (!this.volumes.has(entry.id)) {
              this.volumes.set(entry.id, entry);
              await this.observe(entry);
            }
          }
          volume = this.volumes.get(id);
          this.nativeError = undefined;
        } catch (error) {
          this.nativeError = error;
        }
      }
    }
    if (!volume)
      throw new StorageUnavailableError(
        "The file's storage directory is not mounted",
        { cause: this.nativeError },
      );
    return volume;
  }
  async setDefault(id: string): Promise<void> {
    const volume = await this.getVolume(id);
    if (volume instanceof DirectoryVolume)
      await volume.authorize();
    await volume.stat("");
    await this.database.put("settings", "defaultMount", id);
    this.selected = id;
    this.changed();
  }
  async mountDirectory(): Promise<string | null> {
    // Start the picker synchronously within the user's activation, before DB awaits.
    const picked = this.native
      ? this.native.pickDirectory()
      : window.showDirectoryPicker({
          mode: "readwrite",
          id: "weblink-storage",
        });
    const result = await picked;
    if (!result) return null;
    await this.initialize();
    let volume: VfsVolume;
    if ("stat" in result) volume = result;
    else {
      for (const existing of this.volumes.values()) {
        if (
          existing instanceof DirectoryVolume &&
          (await existing.handle.isSameEntry(result))
        ) {
          this.changed(existing.id);
          return existing.id;
        }
      }
      const id = `directory-${crypto.randomUUID()}`;
      volume = new DirectoryVolume(id, result.name, result);
      await this.database.put("mounts", id, {
        id,
        name: result.name,
        kind: "directory",
        handle: result,
      } satisfies StoredMount);
    }
    this.volumes.set(volume.id, volume);
    await this.observe(volume);
    this.changed();
    return volume.id;
  }
  async authorize(
    id: string,
    options: StorageAuthorizationOptions = {},
  ): Promise<void> {
    const volume = this.volumes.get(id);
    if (volume instanceof DirectoryVolume) {
      await volume.authorize();
      if ((await volume.stat(""))?.kind !== "directory")
        throw new StorageUnavailableError(
          "Storage directory is unavailable",
        );
      // A previous scan may have failed before permission was granted. Finish it,
      // then restore directory identities before the upload can reuse content.
      if (options.refresh !== false) {
        await this.scanning;
        await this.scanDirectories();
      }
    } else if (
      (await (await this.getVolume(id)).stat(""))?.kind !==
      "directory"
    )
      throw new StorageUnavailableError(
        "Storage directory is unavailable",
      );
    if (options.refresh !== false) this.changed(id);
  }
  /** Call from the upload gesture, before file reading/hashing can consume activation. */
  async authorizeDefault(
    options?: StorageAuthorizationOptions,
  ): Promise<void> {
    if (
      !(
        this.volumes.get(this.selected) instanceof
        DirectoryVolume
      )
    )
      await this.initialize();
    await this.authorize(this.selected, options);
  }
  async readFile(
    mountId: string,
    path: string,
  ): Promise<StoredFile> {
    const volume = await this.getVolume(mountId);
    const stat = await volume.stat(path);
    if (!stat || stat.kind !== "file")
      throw new StorageUnavailableError(
        "File is unavailable",
      );
    return volume.file(path, {
      name: path.split("/").at(-1)!,
      type: "",
      lastModified: stat.modified,
    });
  }
  async list(): Promise<string[]> {
    await this.initialize();
    const failed = new Set(
      this.migrationProgress?.failures.map(({ id }) => id),
    );
    return [
      ...new Set([
        ...[...this.directoryListing.values()].flat(),
        ...(await this.database.all<StoredVfsFile>("files"))
          .filter((file) => file.mountId === "indexeddb")
          .map((file) => file.id),
      ]),
    ].filter((id) => !failed.has(id));
  }
  /** Explicit deletion removes the selected path even after content deduplication. */
  async removeSource(id: string): Promise<void> {
    await this.initialize();
    // References can have an independent source even when the content was reused.
    if (!this.directoryFiles.has(id)) {
      const record = await this.database.file(id);
      if (!record) return;
      if (
        this.writableFiles.isWriting(
          record.mountId,
          record.path,
        )
      )
        throw new Error(
          "Stop recording before deleting this file",
        );
      const cache = await this.createCache(id, {
        memoryChunks: 0,
        isRetained: () => false,
        existingOnly: true,
      });
      await cache.cleanup({ deleteSource: true });
      return;
    }
    await withExclusiveTask(`storage:${id}`, async () => {
      const record = await this.directoryFiles.file(id);
      if (
        record?.source !== "directory" ||
        record.present === false
      )
        return;
      const volume = await this.getVolume(record.mountId);
      if (
        this.writableFiles.isWriting(
          record.mountId,
          record.path,
        )
      )
        throw new Error(
          "Stop recording before deleting this file",
        );
      const stat = await volume.stat(record.path);
      if (stat && stat.revision !== record.revision)
        throw new StorageUnavailableError(
          "Directory file changed; refresh before deleting it",
        );
      await volume.remove(record.path);
      this.directoryFiles.absent(id);
    });
  }
  private listing = new Set<string>();
  private synchronizing?: Promise<FileStorageSnapshot>;
  synchronize(): Promise<FileStorageSnapshot> {
    if (this.synchronizing) return this.synchronizing;
    const work = async () => {
      await this.initialize();
      const directory = await this.scanDirectories();
      const files = await this.list();
      const current = new Set(files);
      const removed = new Set(directory.removed);
      for (const id of this.listing)
        if (!current.has(id)) removed.add(id);
      this.listing = current;
      return { files, removed: [...removed] };
    };
    return (this.synchronizing = work().finally(() => {
      this.synchronizing = undefined;
    }));
  }
  private scanDirectories(): Promise<{
    files: string[];
    removed: string[];
  }> {
    if (this.scanning) return this.scanning;
    const scan = async () => {
      const volumes = [...this.volumes.values()].filter(
        (volume) => volume.kind !== "indexeddb",
      );
      // Imports can publish an identity before the first watch scan sees it.
      // Snapshot known identities before scanning so imports completing during
      // this scan are not incorrectly marked as absent.
      const known = volumes.map(
        (volume) =>
          new Set([
            ...(this.directoryListing.get(volume.id) ?? []),
            ...this.directoryFiles.directoryIds(volume.id),
          ]),
      );
      const results = await Promise.allSettled(
        volumes.map(async (volume) => {
          const version = this.directoryFiles.version;
          if (this.directoryFiles.isFinalizing(volume.id))
            throw new StorageUnavailableError(
              "Directory is completing a transfer",
            );
          const records = await scanDirectory(
            volume,
            this.lifetime.signal,
            (path) =>
              this.writableFiles.isWriting(
                volume.id,
                path,
              ) ||
              this.directoryFiles.isWriting(
                volume.id,
                path,
              ),
            this.directoryVerification,
          );
          if (
            this.directoryFiles.isFinalizing(volume.id) ||
            version !== this.directoryFiles.version
          )
            throw new StorageUnavailableError(
              "Directory is completing a transfer",
            );
          return [
            ...records,
            ...this.writableFiles
              .records(volume.id)
              .filter(
                (record) =>
                  !record.path
                    .split("/")
                    .some(isHiddenDirectoryEntry),
              ),
          ];
        }),
      );
      this.lifetime.signal.throwIfAborted();
      this.directoriesAccessible =
        this.nativeError === undefined &&
        volumes.length > 0 &&
        results.every(
          (result) => result.status === "fulfilled",
        );
      const removed: string[] = [];
      results.forEach((result, index) => {
        if (result.status !== "fulfilled") return;
        const volume = volumes[index];
        const records = result.value;
        const ids = new Set(
          records.map((record) => record.id),
        );
        for (const id of known[index])
          if (!ids.has(id)) {
            this.directoryFiles.absent(id);
            removed.push(id);
          }
        for (const record of records)
          this.directoryFiles.register(record);
        this.directoryListing.set(volume.id, [...ids]);
      });
      this.directoryFiles.confirmMissing(
        this.directoriesAccessible,
      );
      return {
        files: [...this.directoryListing.values()].flat(),
        removed,
      };
    };
    return (this.scanning = scan().finally(() => {
      this.scanning = undefined;
    }));
  }
  async createCache(
    id: string,
    options: {
      memoryChunks: number;
      isRetained: () => boolean;
      existingOnly?: boolean;
    },
  ): Promise<ChunkCache> {
    await this.initialize();
    const failed = this.migrationProgress?.failures.find(
      (failure) => failure.id === id,
    );
    if (failed)
      throw new StorageUnavailableError(
        `Legacy file migration failed: ${failed.error}`,
      );
    if (!/^[a-zA-Z0-9_-]+$/.test(id))
      throw new Error("Invalid storage ID");
    let directory = this.directoryFiles.has(id);
    await withExclusiveTask(`storage:${id}`, async () => {
      if (
        directory ||
        (
          await this.database.get<StoredVfsFile>(
            "files",
            id,
          )
        )?.mountId === "indexeddb"
      )
        return;
      if (
        options.existingOnly ||
        id.startsWith("directory_")
      ) {
        this.directoryFiles.unavailable(
          id,
          this.listing.has(id) ||
            (id.startsWith("directory_") &&
              this.directoriesAccessible),
        );
        directory = true;
        return;
      }
      this.selected =
        (await this.database.get<string>(
          "settings",
          "defaultMount",
        )) ?? this.selected;
      const volume = await this.getVolume(this.selected);
      await volume.stat("");
      if (volume.kind !== "indexeddb") {
        this.directoryFiles.allocate(id, volume.id);
        directory = true;
      } else {
        await this.database.put("files", id, {
          id,
          mountId: volume.id,
          path: "",
          info: null,
          chunks: {},
          complete: false,
        } satisfies StoredVfsFile);
      }
    });
    return new VfsChunkCache(
      id,
      directory ? this.directoryFiles : this.database,
      (mountId) =>
        directory
          ? this.directoryFiles.payloadVolume(mountId)
          : this.getVolume(mountId),
      options.isRetained,
      this.native,
      this.directoryVerification,
    );
  }
  onMigrationProgress(
    listener: (progress: StorageMigrationProgress) => void,
  ): () => void {
    this.migrationListeners.add(listener);
    if (this.migrationProgress)
      listener(this.migrationProgress);
    return () => {
      this.migrationListeners.delete(listener);
    };
  }
  onChange(
    listener: (mountId?: string) => void,
  ): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private changed(mountId?: string): void {
    if (!this.disposed)
      this.listeners.forEach((listener) =>
        listener(mountId),
      );
  }
  dispose(): void {
    this.disposed = true;
    this.lifetime.abort();
    this.watches.forEach((stop) => stop());
    this.watches.clear();
    this.listeners.clear();
    this.migrationListeners.clear();
    // Migration may still be rolling back staging pages after abort. Close only
    // after it settles, so its cleanup cannot reopen a disposed service's DB.
    void (this.initializing ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.writableFiles.dispose())
      .then(() => this.database.close());
  }
}
