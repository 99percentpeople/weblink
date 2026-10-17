import type {
  ChunkCache,
  ChunkCacheEventMap,
  ChunkMetaData,
  FileMetaData,
  FileWriteProgress,
  FileWriteOptions,
} from "@/libs/domain/file";
import type {
  NativeFileSystem,
  StoredFile,
  VfsVolume,
} from "@weblink/platform";
import type { FileStorageInfo } from "@/libs/domain/file-storage";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
import {
  StorageUnavailableError,
  storageFilename,
} from "@/libs/domain/vfs";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import { mergeRanges } from "@/libs/utils/range";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import { expectedChunkSize } from "@/libs/domain/file-chunks";
import { snapshotFileMetadata } from "../storage/metadata-snapshot";
import { fingerprintBlob } from "../storage/fingerprint";
import {
  type VfsFileStore,
  type StoredVfsFile,
} from "./database";
import type { DirectoryVerification } from "./directory-verification";

const BATCH_BYTES = 4 * 1024 * 1024;
const digest = async (bytes: ArrayBuffer) =>
  (await fingerprintBlob(new Blob([bytes]))).digest;

/** The checkpoint contains only committed bytes. Preallocated length is never progress. */
export class VfsChunkCache
  extends MultiEventEmitter<ChunkCacheEventMap>
  implements ChunkCache
{
  private pending = new Map<number, ArrayBuffer>();
  private pendingBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private current?: StoredVfsFile;
  /** A live cache can prove its known version disappeared even after its metadata was removed. */
  private missing?: StoredVfsFile;
  private snapshot?: {
    revision: string;
    mountId: string;
    path: string;
    file: StoredFile;
  };
  constructor(
    readonly id: string,
    private readonly database: VfsFileStore,
    private readonly volume: (
      id: string,
    ) => Promise<VfsVolume>,
    private readonly isRetained: () => boolean = () =>
      false,
    private readonly native?: NativeFileSystem,
    private readonly verification?: DirectoryVerification,
  ) {
    super();
  }
  private run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail
      .catch(() => {})
      .then(() =>
        withExclusiveTask(`storage:${this.id}`, work),
      )
      .catch((error) => {
        this.current = undefined;
        throw error;
      });
    this.tail = next;
    return next;
  }
  private async record(): Promise<StoredVfsFile> {
    if (this.closed)
      throw new Error("File storage was closed");
    const record = await this.database.file(
      this.id,
      this.current,
    );
    if (!record)
      throw new Error("File storage was removed");
    this.current = record;
    return record;
  }
  private async checked(
    record: StoredVfsFile,
  ): Promise<VfsVolume> {
    if (record.error)
      throw new StorageUnavailableError(record.error);
    // A finalized receive can retire its temporary identity while its payload
    // is still needed by the active verifier. Only source/tombstone absence is final.
    if (
      record.present === false &&
      (record.source === "directory" ||
        record === this.missing)
    )
      throw new StorageUnavailableError(
        "Stored file was removed or replaced",
        { missing: true },
      );
    const volume = await this.volume(record.mountId);
    if (!record.info) return volume;
    if (record.draft)
      throw new Error("Recording is unfinished");
    const stat = await volume.stat(record.path);
    if (
      !stat ||
      stat.kind !== "file" ||
      stat.size !== record.info.fileSize
    )
      throw new StorageUnavailableError(
        "Stored file is missing or its size changed",
      );
    if (stat.revision !== record.revision) {
      this.snapshot = undefined;
      if (record.complete)
        throw new StorageUnavailableError(
          "Stored file changed outside Weblink; import it again to use the new content",
        );
      // A crash can leave newer bytes than the checkpoint. Verify old ranges before reuse.
      const valid: Record<number, string> = {};
      for (const [key, hash] of Object.entries(
        record.chunks,
      )) {
        const index = Number(key);
        const bytes = await volume.read(
          record.path,
          index * record.info.chunkSize!,
          expectedChunkSize(record.info, index),
        );
        if ((await digest(bytes)) === hash)
          valid[index] = hash;
      }
      const after = await volume.stat(record.path);
      if (!after || after.revision !== stat.revision)
        throw new StorageUnavailableError(
          "File changed while checking resumable data",
        );
      const removed = Object.keys(record.chunks)
        .map(Number)
        .filter((index) => !valid[index]);
      record.chunks = valid;
      record.revision = stat.revision;
      await this.database.checkpoint(record, [], removed);
    }
    return volume;
  }
  async initialize(): Promise<void> {
    await this.refresh();
  }
  async refresh(): Promise<void> {
    this.dispatchEvent("update", await this.getInfo());
  }
  async setInfo(
    data: Omit<ChunkMetaData, "id">,
    signal?: AbortSignal,
    onProgress?: (progress: FileWriteProgress) => void,
  ): Promise<void> {
    const supplied = snapshotFileMetadata({
      ...data,
      id: this.id,
    });
    await this.flush();
    await this.run(async () => {
      signal?.throwIfAborted();
      const record = await this.record();
      if (record.source === "directory")
        throw new Error(
          "Indexed directory files are read-only cache sources",
        );
      const { file, ...rest } = supplied;
      const info = snapshotFileMetadata({
        ...rest,
        chunkSize:
          rest.chunkSize ??
          record.info?.chunkSize ??
          256 * 1024,
        id: this.id,
      });
      if (
        !Number.isSafeInteger(info.fileSize) ||
        info.fileSize < 0 ||
        !Number.isSafeInteger(info.chunkSize) ||
        info.chunkSize < 1
      )
        throw new Error("Invalid file size or chunk size");
      if (
        record.info &&
        (record.info.fileSize !== info.fileSize ||
          record.info.chunkSize !== info.chunkSize)
      )
        throw new Error(
          "Cannot change an existing transfer's file size or chunk size",
        );
      const volume = await this.volume(record.mountId);
      if (file && file.size !== info.fileSize)
        throw new Error(
          "File size does not match metadata",
        );
      if (!record.info) {
        if (this.database.create)
          await this.database.create(
            record,
            info,
            file,
            signal,
            onProgress,
          );
        else {
          record.path = `Weblink Files/${this.id}/${storageFilename(info.fileName)}`;
          if (await volume.stat(record.path))
            throw new StorageUnavailableError(
              "Storage path already exists",
            );
          // Save location before touching bytes so a failed creation never changes mounts.
          record.info = info;
          await this.database.checkpoint(record);
          record.revision = (
            await volume.commit(
              record.path,
              [],
              info.fileSize,
            )
          ).revision;
        }
      } else if (
        !record.revision &&
        !this.database.create
      ) {
        const existing = await volume.stat(record.path);
        if (existing && existing.size !== info.fileSize)
          throw new StorageUnavailableError(
            "Stored file size changed",
          );
        record.revision = (
          existing ??
          (await volume.commit(
            record.path,
            [],
            info.fileSize,
          ))
        ).revision;
      } else await this.checked(record);
      record.info = info;
      if (file && !record.complete) {
        for (
          let offset = 0;
          offset < file.size;
          offset += BATCH_BYTES
        ) {
          signal?.throwIfAborted();
          const bytes = new Uint8Array(
            await file
              .slice(offset, offset + BATCH_BYTES)
              .arrayBuffer(),
          );
          signal?.throwIfAborted();
          record.revision = (
            await volume.commit(record.path, [
              { offset, data: bytes },
            ])
          ).revision;
          onProgress?.({
            phase: "writing",
            bytes: offset + bytes.byteLength,
          });
        }
        record.complete = true;
      }
      signal?.throwIfAborted();
      await this.database.checkpoint(record, [], [], {
        signal,
        onProgress,
      });
    });
    await this.refresh();
  }
  async storeChunk(
    index: number,
    data: ArrayBufferLike,
  ): Promise<void> {
    const bytes = new Uint8Array(data).slice().buffer;
    await this.run(async () => {
      const record = this.current ?? (await this.record());
      if (!record.info)
        throw new Error("File metadata is missing");
      if (
        expectedChunkSize(record.info, index) !==
        bytes.byteLength
      )
        throw new Error("Invalid chunk size");
      if (
        record.complete ||
        record.chunks[index] ||
        this.pending.has(index)
      )
        return;
      this.pending.set(index, bytes);
      this.pendingBytes += bytes.byteLength;
      if (this.pendingBytes >= BATCH_BYTES)
        await this.writePending();
    });
    if (this.pending.size && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush().catch(console.error);
      }, 1000);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    return this.run(() => this.writePending());
  }
  private async writePending(): Promise<void> {
    if (!this.pending.size) return;
    const record = await this.record();
    const volume = await this.checked(record);
    if (!record.info)
      throw new Error("File metadata is missing");
    if (record.complete) {
      this.pending.clear();
      this.pendingBytes = 0;
      return;
    }
    const batch = [...this.pending].filter(
      ([index]) => !record.chunks[index],
    );
    const hashes = await Promise.all(
      batch.map(
        async ([index, bytes]) =>
          [index, await digest(bytes)] as const,
      ),
    );
    if (batch.length) {
      const stat = await volume.commit(
        record.path,
        batch.map(([index, bytes]) => ({
          offset: index * record.info!.chunkSize!,
          data: new Uint8Array(bytes),
        })),
      );
      record.revision = stat.revision;
      for (const [index, hash] of hashes)
        record.chunks[index] = hash;
      // Never publish a checkpoint until the volume has committed successfully.
      await this.database.checkpoint(record, hashes);
    }
    this.pending.clear();
    this.pendingBytes = 0;
    if (batch.length)
      this.dispatchEvent("update", {
        ...record.info,
        capabilities: this.describeStorage(record, volume)
          .capabilities,
        storageMountId: record.mountId,
        isComplete: false,
        isMerging: false,
        cachedBytes: this.bytes(record),
        chunkCount: Object.keys(record.chunks).length,
      });
  }
  private async info(
    record: StoredVfsFile,
  ): Promise<FileMetaData | null> {
    if (!record.info) return null;
    let capabilities: FileMetaData["capabilities"];
    try {
      capabilities = this.describeStorage(
        record,
        await this.volume(record.mountId),
      ).capabilities;
      if (record.draft) {
        const stat = await (
          await this.volume(record.mountId)
        ).stat(record.path);
        if (!stat || record.present === false)
          throw new StorageUnavailableError(
            "Recording draft was removed",
            { missing: true },
          );
        return {
          ...record.info,
          fileSize: stat.size,
          capabilities,
          storageMountId: record.mountId,
          isComplete: false,
          cachedBytes: stat.size,
          chunkCount: 0,
        };
      }
      await this.checked(record);
      const complete =
        record.complete ||
        Object.keys(record.chunks).length ===
          Math.ceil(
            record.info.fileSize / record.info.chunkSize!,
          );
      const file = complete
        ? await this.readCompleteFile(record)
        : undefined;
      return {
        ...record.info,
        capabilities,
        storageMountId: record.mountId,
        file,
        storageUnavailable: undefined,
        storageMissing: undefined,
        verifyContent: record.verifyContent,
        isComplete: complete,
        cachedBytes: complete
          ? record.info.fileSize
          : this.bytes(record),
        chunkCount: Object.keys(record.chunks).length,
        isMerging: false,
      };
    } catch (error) {
      this.current = undefined;
      this.snapshot = undefined;
      return {
        ...record.info,
        capabilities,
        storageMountId: record.mountId,
        file: undefined,
        isComplete: false,
        cachedBytes: this.bytes(record),
        chunkCount: Object.keys(record.chunks).length,
        storageUnavailable:
          error instanceof Error
            ? error.message
            : String(error),
        storageMissing: record.present === false,
      };
    }
  }
  private bytes(record: StoredVfsFile): number {
    return record.info
      ? Object.keys(record.chunks).reduce(
          (bytes, key) =>
            bytes +
            expectedChunkSize(record.info!, Number(key)),
          0,
        )
      : 0;
  }
  private async readFile(
    record: StoredVfsFile,
  ): Promise<StoredFile> {
    if (
      this.snapshot &&
      this.snapshot.revision === record.revision &&
      this.snapshot.mountId === record.mountId &&
      this.snapshot.path === record.path
    )
      return this.snapshot.file;
    const info = record.info!;
    const volume = await this.volume(record.mountId);
    const file = await volume.file(record.path, {
      name: info.fileName,
      type: info.mimetype ?? "",
      lastModified: info.lastModified ?? 0,
    });
    const after = await volume.stat(record.path);
    if (
      !after ||
      after.revision !== record.revision ||
      file.size !== info.fileSize
    )
      throw new StorageUnavailableError(
        "File changed while opening",
      );
    this.snapshot = {
      revision: record.revision!,
      mountId: record.mountId,
      path: record.path,
      file,
    };
    return file;
  }
  private async readCompleteFile(
    record: StoredVfsFile,
  ): Promise<StoredFile> {
    const completed = !record.complete;
    if (completed) {
      record.complete = true;
      await this.database.checkpoint(record);
    }
    const file = await this.readFile(record);
    if (completed) {
      this.dispatchEvent("update", {
        ...record.info!,
        capabilities: this.describeStorage(
          record,
          await this.volume(record.mountId),
        ).capabilities,
        storageMountId: record.mountId,
        file,
        verifyContent: record.verifyContent,
        isComplete: true,
        isMerging: false,
        cachedBytes: file.size,
        chunkCount: Object.keys(record.chunks).length,
      });
      this.dispatchEvent("complete", file);
    }
    return file;
  }
  async getInfo(): Promise<FileMetaData | null> {
    if (this.closed) return null;
    return this.run(async () => {
      const record = await this.database.file(
        this.id,
        this.current,
      );
      if (!record) {
        const previous = this.missing ?? this.current;
        if (previous?.info && this.isRetained()) {
          this.missing = { ...previous, present: false };
          clearTimeout(this.timer);
          this.pending.clear();
          return this.info(this.missing);
        }
        // Another window may already have removed this directory entry/cache.
        this.closed = true;
        clearTimeout(this.timer);
        this.snapshot = undefined;
        this.pending.clear();
        this.dispatchEvent("cleanup", undefined);
        return null;
      }
      this.missing = undefined;
      this.current = record;
      return this.info(record);
    });
  }
  async storageIdentity(): Promise<string> {
    return this.run(async () => {
      const record = await this.record();
      await this.checked(record);
      return this.database.identity?.(record) ?? this.id;
    });
  }
  private describeStorage(
    record: StoredVfsFile,
    volume: VfsVolume,
  ): FileStorageInfo {
    return {
      mountId: record.mountId,
      capabilities: {
        save:
          volume.kind === "indexeddb"
            ? "download"
            : "save-as",
        inlineSave: volume.kind !== "native",
        reveal:
          volume.kind === "native" &&
          !!this.native?.revealFile,
      },
    };
  }
  async storageInfo(): Promise<FileStorageInfo | null> {
    if (this.closed) return null;
    return this.run(async () => {
      const record =
        (await this.database.file(this.id, this.current)) ??
        this.missing;
      if (!record) return null;
      const volume = await this.volume(record.mountId);
      return this.describeStorage(record, volume);
    });
  }
  async reveal(): Promise<void> {
    return this.run(async () => {
      const record = await this.record();
      const volume = await this.checked(record);
      if (
        !this.describeStorage(record, volume).capabilities
          .reveal
      )
        throw new Error("File location is unavailable");
      await this.native!.revealFile!(
        record.mountId,
        record.path,
      );
    });
  }
  async getCachedKeys(): Promise<number[]> {
    await this.flush();
    return this.run(async () => {
      const record = await this.record();
      if (record.draft) return [];
      await this.checked(record);
      return Object.keys(record.chunks)
        .map(Number)
        .sort((a, b) => a - b);
    });
  }
  async getChunkCount(): Promise<number> {
    return (await this.getCachedKeys()).length;
  }
  async calcCachedBytes(): Promise<number | null> {
    await this.flush();
    return (await this.getInfo())?.cachedBytes ?? null;
  }
  async getReqRanges() {
    await this.flush();
    return this.run(async () => {
      const record = await this.record();
      if (record.draft) return null;
      await this.checked(record);
      if (!record.info) return null;
      if (record.complete) return [];
      const missing: number[] = [];
      for (
        let i = 0;
        i <
        Math.ceil(
          record.info.fileSize / record.info.chunkSize!,
        );
        i++
      )
        if (!record.chunks[i]) missing.push(i);
      return mergeRanges(missing);
    });
  }
  async getChunk(
    index: number,
  ): Promise<ArrayBuffer | null> {
    await this.flush();
    return this.run(async () => {
      const record = await this.record();
      if (record.draft) return null;
      const volume = await this.checked(record);
      if (
        !record.info ||
        (!record.complete && !record.chunks[index])
      )
        return null;
      if (record.source === "directory") {
        const file = await this.readFile(record);
        const offset = index * record.info.chunkSize!;
        return file
          .slice(
            offset,
            offset + expectedChunkSize(record.info, index),
          )
          .arrayBuffer();
      }
      const bytes = await volume.read(
        record.path,
        index * record.info.chunkSize!,
        expectedChunkSize(record.info, index),
      );
      if (
        record.chunks[index] &&
        (await digest(bytes)) !== record.chunks[index]
      )
        throw new StorageUnavailableError(
          "Stored chunk changed",
        );
      return bytes;
    });
  }
  async isTransferComplete(): Promise<boolean> {
    await this.flush();
    return !!(await this.getInfo())?.isComplete;
  }
  async getFile(): Promise<StoredFile | null> {
    await this.flush();
    return this.run(async () => {
      const record = await this.record();
      if (record.draft) return null;
      await this.checked(record);
      if (
        !record.info ||
        (!record.complete &&
          Object.keys(record.chunks).length !==
            Math.ceil(
              record.info.fileSize / record.info.chunkSize!,
            ))
      )
        return null;
      return this.readCompleteFile(record);
    });
  }
  mergeFile(): Promise<StoredFile | null> {
    return this.getFile();
  }
  async fingerprint(
    file: StoredFile,
    options: FileWriteOptions = {},
    compute?: () => Promise<FileFingerprint>,
  ): Promise<FileFingerprint | undefined> {
    if (!this.database.fingerprint && !this.verification)
      return undefined;
    return this.run(async () => {
      options.signal?.throwIfAborted();
      const record = await this.record();
      await this.checked(record);
      if (
        !record.complete ||
        (await this.readFile(record)) !== file
      )
        throw new StorageUnavailableError(
          "File changed while identifying its content",
        );
      if (this.database.fingerprint)
        return this.database.fingerprint(
          record,
          file,
          options,
          compute,
        );
      const volume = await this.volume(record.mountId);
      const stat = await volume.stat(record.path);
      if (!stat) throw new Error("File is unavailable");
      return this.verification!.verify(
        volume,
        record.path,
        stat,
        file,
        options,
        compute,
      );
    });
  }
  async cleanup(
    options: { deleteSource?: boolean } = {},
  ): Promise<void> {
    if (
      this.closed ||
      (this.isRetained() && !options.deleteSource)
    )
      return;
    clearTimeout(this.timer);
    const removed = await this.run(async () => {
      const record = await this.database.file(
        this.id,
        this.current,
      );
      if (!record) {
        this.closed = true;
        this.pending.clear();
        this.missing = undefined;
        this.snapshot = undefined;
        return true;
      }
      if (
        this.database.identity &&
        record.present === false
      ) {
        // This is an absent version/placeholder, not a path we still own.
        // Clearing its index must never delete a replacement file at that path.
        await this.database.removeFile(this.id);
        this.closed = true;
        this.pending.clear();
        this.snapshot = undefined;
        return true;
      }
      // Completed directory files belong to the user; reconciliation and releasing
      // a transfer must not delete a file whose identity now comes from its path.
      if (
        this.database.identity &&
        record.complete &&
        !options.deleteSource
      )
        return false;
      if (
        record.source === "directory" &&
        !options.deleteSource &&
        record.present !== false
      )
        return false;
      if (
        record.info &&
        (record.source !== "directory" ||
          (options.deleteSource &&
            record.present !== false))
      ) {
        const volume = await this.volume(record.mountId);
        if (record.source === "directory") {
          const current = await volume.stat(record.path);
          if (
            current &&
            current.revision !== record.revision
          )
            throw new StorageUnavailableError(
              "Directory file changed; refresh before deleting it",
            );
        }
        await volume.remove(record.path);
      }
      await this.database.removeFile(this.id);
      this.closed = true;
      this.pending.clear();
      this.snapshot = undefined;
      return true;
    });
    if (removed) this.dispatchEvent("cleanup", undefined);
  }
  dispose(): void {
    clearTimeout(this.timer);
    this.snapshot = undefined;
  }
}
