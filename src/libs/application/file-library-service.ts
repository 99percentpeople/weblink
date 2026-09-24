import type {
  ChunkCache,
  ChunkMetaData,
  FileSource,
} from "@/libs/domain/file";
import {
  contentKey,
  type FileFingerprint,
} from "@/libs/domain/protocol/file-fingerprint";
import type {
  ContentRecord,
  FileLibraryRepository,
  FileReference,
} from "@/libs/domain/file-library";
import type { FingerprintOptions } from "./file-fingerprint-service";
import { withContentLock } from "./files/content-lock";
import { ReferenceChunkCache } from "./files/reference-chunk-cache";

export interface FileLibraryOptions {
  repository: FileLibraryRepository;
  getChunkSize?(): number;
  fingerprint(
    file: Blob,
    options?: FingerprintOptions,
  ): Promise<FileFingerprint>;
  storage(id: string): Promise<ChunkCache>;
  getCache(id: string): ChunkCache | null;
  publish(cache: ReferenceChunkCache): Promise<void>;
}
export interface FileImportResult {
  cache: ChunkCache;
  reused: boolean;
}
const metadata = (
  file: File,
): Omit<ChunkMetaData, "id" | "file"> => ({
  fileName: file.name,
  fileSize: file.size,
  mimetype: file.type,
  lastModified: file.lastModified,
  createdAt: Date.now(),
});

const identity = (ref: ChunkMetaData) =>
  JSON.stringify([
    ref.id,
    ref.fileName,
    ref.fileSize,
    ref.lastModified,
    ref.mimetype ?? "",
    ref.chunkSize,
    !!ref.roomAttachment,
    ref.roomOfferId,
    ref.from,
    ref.contentKey,
  ]);
const referenceMetadata = (
  info: ChunkMetaData,
): ChunkMetaData => ({
  id: info.id,
  fileName: info.fileName,
  fileSize: info.fileSize,
  lastModified: info.lastModified,
  mimetype: info.mimetype,
  chunkSize: info.chunkSize,
  from: info.from,
  roomAttachment: info.roomAttachment,
  roomOfferId: info.roomOfferId,
  createdAt: info.createdAt,
  aliases: info.aliases ? [...info.aliases] : undefined,
  libraryPinned: info.libraryPinned,
});

/** Content ownership is local. Wire IDs and room authorization belong to references. */
export class FileLibraryService {
  private readonly references = new Map<
    string,
    ReferenceChunkCache
  >();
  private readonly storageOwners = new Map<
    string,
    string
  >();
  private readonly changes = new Set<() => void>();
  private readonly removals = new Set<
    (ids: string[]) => void
  >();
  onRemove(listener: (ids: string[]) => void): () => void {
    this.removals.add(listener);
    return () => {
      this.removals.delete(listener);
    };
  }
  private readonly unshares = new Set<
    (ids: string[]) => void
  >();
  private sharedIds = new Set<string>();
  onUnshare(listener: (ids: string[]) => void): () => void {
    this.unshares.add(listener);
    return () => {
      this.unshares.delete(listener);
    };
  }
  private channel?: BroadcastChannel;
  private refreshing?: Promise<void>;
  constructor(
    private readonly options: FileLibraryOptions,
  ) {}
  private get repository() {
    return this.options.repository;
  }

  async initialize(): Promise<void> {
    const contents = await this.repository.contents();
    for (const record of contents)
      this.storageOwners.set(record.storageId, record.key);
    await this.refresh();
    if (typeof BroadcastChannel !== "undefined") {
      this.channel?.close();
      this.channel = new BroadcastChannel(
        "weblink-file-library-v1",
      );
      this.channel.onmessage = () => {
        void this.refresh().catch(console.error);
      };
    }
    // Pending imports have no published references. A cross-tab lock waits for
    // a live writer before deciding whether a crashed writer needs recovery.
    for (const record of contents.filter(
      (item) => item.state === "pending",
    )) {
      void withContentLock(record.key, async () => {
        const current = await this.repository.content(
          record.key,
        );
        if (current?.state !== "pending") return;
        if (
          !(
            typeof navigator !== "undefined" &&
            navigator.locks
          ) &&
          Date.now() - current.createdAt < 300_000
        )
          return;
        await this.removeRecord(current);
      }).catch(console.error);
    }
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const work = async () => {
      const records = await this.repository.references();
      const ids = new Set(records.map((ref) => ref.id));
      for (const [id, cache] of this.references) {
        if (!ids.has(id)) {
          cache.invalidate();
          this.references.delete(id);
        }
      }
      for (const ref of records) await this.publish(ref);
      this.storageOwners.clear();
      for (const record of await this.repository.contents())
        this.storageOwners.set(
          record.storageId,
          record.key,
        );
      const shared = new Set(
        (await this.repository.contents())
          .filter(
            (record) =>
              record.isShared && record.sharedReferenceId,
          )
          .map((record) => record.sharedReferenceId!),
      );
      const revoked = [...this.sharedIds].filter(
        (id) => !shared.has(id),
      );
      this.sharedIds = shared;
      if (revoked.length)
        this.unshares.forEach((listener) =>
          listener(revoked),
        );
      this.changed(false);
    };
    const pending = work().finally(() => {
      this.refreshing = undefined;
    });
    this.refreshing = pending;
    return pending;
  }

  dispose(): void {
    this.channel?.close();
    this.changes.clear();
    this.removals.clear();
    this.unshares.clear();
  }

  onChange(listener: () => void): () => void {
    this.changes.add(listener);
    return () => {
      this.changes.delete(listener);
    };
  }
  private changed(broadcast = true): void {
    if (broadcast)
      this.channel?.postMessage({ changed: true });
    this.changes.forEach((listener) => listener());
  }
  ownsStorage(id: string): boolean {
    return this.storageOwners.has(id);
  }

  private async read(
    record: ContentRecord,
  ): Promise<File | null> {
    if (record.state !== "ready") return null;
    try {
      const info = await (
        await this.options.storage(record.storageId)
      ).getInfo();
      return info?.isComplete &&
        info.file?.size === record.fingerprint.size
        ? (info.file ?? null)
        : null;
    } catch {
      return null;
    }
  }
  private async available(
    key: string,
  ): Promise<ContentRecord | undefined> {
    const record = await this.repository.content(key);
    if (!record || record.state !== "ready") return;
    if (await this.read(record)) return record;
    await this.removeRecord(record);
  }

  /** Check verified local bytes without creating another file reference. */
  async hasContent(
    fingerprint: FileFingerprint,
  ): Promise<boolean> {
    const key = contentKey(fingerprint);
    return withContentLock(
      key,
      async () => !!(await this.available(key)),
    );
  }

  /** Discard only this receive's reference and unowned partial bytes. */
  async discardReceive(
    id: string,
    fingerprint: FileFingerprint,
    storage?: ChunkCache,
  ): Promise<void> {
    const key = contentKey(fingerprint);
    await withContentLock(key, async () => {
      const ref = await this.repository.reference(id);
      if (ref) {
        if (ref.contentKey !== key || ref.sharedReference)
          throw new Error(
            "Cannot discard another file's reference",
          );
        await this.releaseReference(ref);
      }
      const cache = storage ?? this.options.getCache(id);
      if (
        cache &&
        !(cache instanceof ReferenceChunkCache) &&
        !this.ownsStorage(id)
      )
        await cache.cleanup();
    });
  }
  private async publish(
    ref: FileReference,
  ): Promise<ReferenceChunkCache> {
    let cache = this.references.get(ref.id);
    if (!cache) {
      cache = new ReferenceChunkCache(
        ref,
        async () => {
          const current = await this.repository.reference(
            ref.id,
          );
          const record =
            current &&
            (await this.repository.content(
              current.contentKey,
            ));
          return record ? this.read(record) : null;
        },
        (next) => this.repository.putReference(next),
        () => this.release(ref.id),
        async () =>
          !!(await this.repository.content(ref.contentKey))
            ?.isShared,
      );
      this.references.set(ref.id, cache);
      await this.options.publish(cache);
    } else await cache.refresh(ref);
    return cache;
  }

  async importFile(
    file: File,
    options: FingerprintOptions = {},
  ): Promise<FileImportResult> {
    const fingerprint = await this.options.fingerprint(
      file,
      options,
    );
    options.signal?.throwIfAborted();
    return this.acquire(
      file,
      fingerprint,
      {
        ...metadata(file),
        id: crypto.randomUUID(),
        chunkSize:
          this.options.getChunkSize?.() ?? 256 * 1024,
        libraryPinned: true,
      },
      options,
    );
  }

  async prepare(
    source: FileSource,
    info: Partial<ChunkMetaData> = {},
    options: FingerprintOptions = {},
  ): Promise<ChunkCache> {
    const isLibrary = !(source instanceof File);
    let file: File;
    let fingerprint: FileFingerprint;
    let storageId: string | undefined;
    if (isLibrary) {
      const cache = this.options.getCache(
        source.localFileId,
      );
      const stored = cache && (await cache.getInfo());
      if (!cache || !stored?.isComplete || !stored.file)
        throw new Error(
          "Selected file is no longer available",
        );
      file = stored.file;
      if (stored.contentKey && stored.fingerprint)
        fingerprint = stored.fingerprint;
      else {
        fingerprint = await this.options.fingerprint(
          file,
          options,
        );
        if (
          stored.fingerprint &&
          contentKey(stored.fingerprint) !==
            contentKey(fingerprint)
        ) {
          await cache.cleanup();
          throw new Error(
            "File content verification failed; request the file again",
          );
        }
        storageId = cache.id;
        // Keep the old local item/history resolvable without copying its bytes.
        await this.acquire(
          file,
          fingerprint,
          { ...stored, id: cache.id, libraryPinned: true },
          options,
          cache.id,
        );
      }
    } else {
      file = source;
      fingerprint = await this.options.fingerprint(
        file,
        options,
      );
    }
    options.signal?.throwIfAborted();
    return (
      await this.acquire(
        file,
        fingerprint,
        {
          ...metadata(file),
          ...info,
          id: info.id ?? crypto.randomUUID(),
        },
        options,
        storageId,
      )
    ).cache;
  }

  private async acquire(
    file: File,
    fingerprint: FileFingerprint,
    info: ChunkMetaData,
    options: FingerprintOptions,
    borrowedStorage?: string,
  ): Promise<FileImportResult> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const result = await this.acquireOnce(
        file,
        fingerprint,
        info,
        options,
        borrowedStorage,
      );
      if (result) return result;
      if (Date.now() >= deadline)
        throw new Error(
          "This file is being imported in another window; retry when it finishes",
        );
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(options.signal?.reason);
        };
        const timer = setTimeout(() => {
          options.signal?.removeEventListener(
            "abort",
            abort,
          );
          resolve();
        }, 50);
        options.signal?.addEventListener("abort", abort, {
          once: true,
        });
        if (options.signal?.aborted) abort();
      });
    }
  }
  private async acquireOnce(
    file: File,
    fingerprint: FileFingerprint,
    info: ChunkMetaData,
    options: FingerprintOptions,
    borrowedStorage?: string,
  ): Promise<FileImportResult | null> {
    fingerprint = { ...fingerprint };
    const key = contentKey(fingerprint);
    return withContentLock(key, async () => {
      options.signal?.throwIfAborted();
      const pending = await this.repository.content(key);
      if (
        pending?.state === "pending" &&
        ((typeof navigator !== "undefined" &&
          navigator.locks) ||
          Date.now() - pending.createdAt > 300_000)
      )
        await this.removeRecord(pending);
      let record = await this.available(key);
      const reused = !!record;
      const refs = record
        ? await this.repository.references(key)
        : [];
      const pinned =
        info.libraryPinned &&
        borrowedStorage !== info.id &&
        refs.find((ref) => ref.libraryPinned);
      if (pinned) {
        const updated = {
          ...pinned,
          aliases: [
            ...new Set([
              ...(pinned.aliases ?? []),
              pinned.fileName,
              info.fileName,
            ]),
          ],
        };
        await this.repository.putReference(updated);
        this.changed();
        return {
          cache: await this.publish(updated),
          reused: true,
        };
      }
      const rest = referenceMetadata(info);
      const reference: FileReference = {
        ...rest,
        contentKey: key,
        fingerprint,
      };
      if (record) {
        const existing = await this.repository.reference(
          reference.id,
        );
        if (
          existing &&
          identity(existing) !== identity(reference)
        )
          throw new Error(
            "File reference identity conflict",
          );
        await this.repository.putReference(reference);
      } else {
        record = {
          key,
          fingerprint,
          storageId:
            borrowedStorage ??
            `content_${crypto.randomUUID()}`,
          createdAt: Date.now(),
          state: "pending",
        };
        if (!(await this.repository.claim(record)))
          return null;
        this.storageOwners.set(record.storageId, key);
        try {
          if (!borrowedStorage) {
            const cache = await this.options.storage(
              record.storageId,
            );
            await cache.setInfo({
              ...metadata(file),
              file,
              fingerprint,
              contentStorage: true,
            });
          }
          options.signal?.throwIfAborted();
          record.state = "ready";
          await this.repository.commit(record, reference);
        } catch (error) {
          await this.repository.removeContent(key);
          this.storageOwners.delete(record.storageId);
          if (!borrowedStorage)
            await (
              await this.options.storage(record.storageId)
            )
              .cleanup()
              .catch(() => {});
          throw error;
        }
      }
      const cache = await this.publish(reference);
      if (options.signal?.aborted) {
        await this.repository.removeReference(reference.id);
        cache.invalidate();
        this.references.delete(reference.id);
        if (!(await this.repository.references(key)).length)
          await this.removeRecord(record);
        this.changed();
        options.signal.throwIfAborted();
      }
      this.changed();
      return { cache, reused };
    });
  }

  /** Attaches only locally verified content. The caller first validates the peer/offer. */
  async reuse(
    fingerprint: FileFingerprint,
    info: ChunkMetaData,
    signal?: AbortSignal,
  ): Promise<ChunkCache | null> {
    fingerprint = { ...fingerprint };
    const key = contentKey(fingerprint);
    if (info.fileSize !== fingerprint.size)
      throw new Error(
        "Fingerprint size does not match the offer",
      );
    return withContentLock(key, async () => {
      signal?.throwIfAborted();
      if (!(await this.available(key))) return null;
      const metadata = referenceMetadata(info);
      const reference: FileReference = {
        ...metadata,
        contentKey: key,
        fingerprint,
      };
      const present = await this.options
        .getCache(info.id)
        ?.getInfo();
      if (
        present &&
        identity({ ...present, contentKey: key }) !==
          identity(reference)
      )
        throw new Error("File reference identity conflict");
      const old = await this.repository.reference(info.id);
      if (old && identity(old) !== identity(reference))
        throw new Error("File reference identity conflict");
      signal?.throwIfAborted();
      await this.repository.putReference(reference);
      const cache = await this.publish(reference);
      if (signal?.aborted) {
        await this.repository.removeReference(reference.id);
        cache.invalidate();
        this.references.delete(reference.id);
        this.changed();
        signal.throwIfAborted();
      }
      this.changed();
      return cache;
    });
  }

  async verifyReceived(
    cache: ChunkCache,
    signal?: AbortSignal,
  ): Promise<File | null> {
    const info = await cache.getInfo();
    const file = await cache.getFile();
    if (!info || !file) return null;
    const fingerprint = await this.options.fingerprint(
      file,
      { signal },
    );
    signal?.throwIfAborted();
    if (
      info.fingerprint &&
      contentKey(info.fingerprint) !==
        contentKey(fingerprint)
    ) {
      await cache.cleanup();
      throw new Error(
        "File content verification failed; request the file again",
      );
    }
    const current = await cache.getInfo();
    signal?.throwIfAborted();
    if (!current || current.fileSize !== info.fileSize)
      throw new DOMException(
        "File was deleted during verification",
        "AbortError",
      );
    await this.acquire(
      file,
      fingerprint,
      { ...info, file: undefined },
      { signal },
      cache.id,
    );
    return file;
  }

  /** One retained reference per content, with a separate directory authorization ID. */
  async setShared(
    id: string,
    enabled: boolean,
  ): Promise<void> {
    let ref = await this.repository.reference(id);
    if (!ref) {
      if (!enabled) return;
      // Lazy upgrade of old complete caches, without inferring intent from history.
      const cache = this.options.getCache(id);
      if (!cache || !(await cache.getInfo())?.isComplete)
        throw new Error("File content is unavailable");
      await this.verifyReceived(cache);
      ref = await this.repository.reference(id);
    }
    if (!ref)
      throw new Error("File content is unavailable");
    const source = ref;
    await withContentLock(source.contentKey, async () => {
      const record = await this.available(
        source.contentKey,
      );
      if (!record)
        throw new Error("File content is unavailable");
      if (!!record.isShared === enabled) return;
      const sharedId =
        record.sharedReferenceId ??
        `shared_${crypto.randomUUID()}`;
      const retained = (await this.repository.reference(
        sharedId,
      )) ?? {
        ...source,
        chunkSize:
          source.chunkSize ??
          this.options.getChunkSize?.() ??
          256 * 1024,
        id: sharedId,
        roomAttachment: undefined,
        roomOfferId: undefined,
        from: undefined,
        libraryPinned: true,
        sharedReference: true,
      };
      await this.repository.commit(
        {
          ...record,
          isShared: enabled,
          sharedReferenceId: sharedId,
        },
        retained,
      );
      if (enabled) this.sharedIds.add(sharedId);
      else {
        this.sharedIds.delete(sharedId);
        this.unshares.forEach((listener) =>
          listener([sharedId]),
        );
      }
      for (const reference of await this.repository.references(
        source.contentKey,
      ))
        await this.publish(reference);
      this.changed();
    });
  }

  async setSharedBatch(
    ids: readonly string[],
    enabled: boolean,
  ): Promise<void> {
    for (const id of new Set(ids))
      await this.setShared(id, enabled);
  }

  async getSharedFile(
    id: string,
  ): Promise<ChunkCache | null> {
    const ref = await this.repository.reference(id);
    if (!ref?.sharedReference) return null;
    const record = await this.repository.content(
      ref.contentKey,
    );
    if (
      !record?.isShared ||
      record.sharedReferenceId !== id ||
      !(await this.read(record))
    )
      return null;
    return this.references.get(id) ?? this.publish(ref);
  }

  async sharedFiles(): Promise<ChunkMetaData[]> {
    const result: ChunkMetaData[] = [];
    for (const record of await this.repository.contents()) {
      if (!record.isShared || !record.sharedReferenceId)
        continue;
      const cache = await this.getSharedFile(
        record.sharedReferenceId,
      );
      const info = await cache?.getInfo();
      if (info?.isComplete) result.push(info);
    }
    return result;
  }

  async releaseAttachment(id: string): Promise<void> {
    const ref = await this.repository.reference(id);
    if (ref && !ref.libraryPinned) await this.release(id);
  }

  async release(id: string): Promise<void> {
    const reference = await this.repository.reference(id);
    if (!reference || reference.sharedReference) return;
    await withContentLock(reference.contentKey, () =>
      this.releaseReference(reference),
    );
  }

  private async releaseReference(
    reference: FileReference,
  ): Promise<void> {
    const id = reference.id;
    await this.repository.removeReference(id);
    this.references.get(id)?.invalidate();
    this.references.delete(id);
    if (
      !(
        await this.repository.references(
          reference.contentKey,
        )
      ).length
    ) {
      const record = await this.repository.content(
        reference.contentKey,
      );
      if (record) await this.removeRecord(record);
    }
    this.changed();
  }

  /** Explicit deletion removes local bytes for all aliases, retaining chat metadata. */
  async removeFile(id: string): Promise<void> {
    const ref = await this.repository.reference(id);
    if (!ref) {
      this.removals.forEach((listener) => listener([id]));
      await this.options.getCache(id)?.cleanup();
      return;
    }
    await withContentLock(ref.contentKey, async () => {
      const record = await this.repository.content(
        ref.contentKey,
      );
      if (record) await this.removeRecord(record);
      this.changed();
    });
  }
  private async removeRecord(
    record: ContentRecord,
  ): Promise<void> {
    const refs = await this.repository.references(
      record.key,
    );
    this.removals.forEach((listener) =>
      listener(refs.map((ref) => ref.id)),
    );
    await this.repository.removeContent(record.key);
    for (const ref of refs) {
      this.references.get(ref.id)?.invalidate();
      this.references.delete(ref.id);
    }
    this.storageOwners.delete(record.storageId);
    await (
      await this.options.storage(record.storageId)
    ).cleanup();
  }
  referenceCount(id: string): Promise<number> {
    return this.repository
      .reference(id)
      .then(async (ref) =>
        ref
          ? (
              await this.repository.references(
                ref.contentKey,
              )
            ).length
          : 1,
      );
  }
}
