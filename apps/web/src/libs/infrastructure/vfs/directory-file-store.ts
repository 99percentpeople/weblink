import {
  RangeFile,
  type StoredFile,
  type VfsVolume,
} from "@weblink/platform";
import type {
  ChunkCacheInfo,
  FileWriteOptions,
  FileWriteProgress,
} from "@/libs/domain/file";
import {
  StorageUnavailableError,
  DirectoryWriteError,
  storageFilename,
} from "@/libs/domain/vfs";
import {
  contentKey,
  type FileFingerprint,
} from "@/libs/domain/protocol/file-fingerprint";
import { snapshotFileMetadata } from "../storage/metadata-snapshot";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import { directoryEntry } from "./directory-entry";
import { finalizeDirectoryFile } from "./directory-finalize";
import { DirectoryVerification } from "./directory-verification";
import {
  decodeDirectoryFilename,
  encodeDirectoryFilename,
  isDirectoryNameBlocked,
} from "./directory-filename";
import type {
  StoredVfsFile,
  VfsFileStore,
} from "./database";
import {
  chunkCheckpointWrites,
  createPartial,
  metadataSlot,
  PARTIAL_SLOT_BYTES,
  PARTIAL_SUFFIX,
  readPartialChunks,
  readPartialHeader,
  type PartialHeader,
} from "./partial-file";

const copy = (record: StoredVfsFile): StoredVfsFile => ({
  ...record,
  info: record.info && snapshotFileMetadata(record.info),
  chunks: { ...record.chunks },
});
type Entry = {
  record: StoredVfsFile;
  readRevision?: string;
  header?: PartialHeader;
  missing?: boolean;
};

/** An in-memory projection only. All durable transfer state lives in its data file. */
export class DirectoryFileStore implements VfsFileStore {
  private readonly entries = new Map<string, Entry>();
  private readonly paths = new Map<string, string>();
  private readonly writingPaths = new Set<string>();
  private readonly finalizing = new Set<string>();
  version = 0;
  isFinalizing(mountId: string): boolean {
    return this.finalizing.has(mountId);
  }
  isWriting(mountId: string, path: string): boolean {
    return this.writingPaths.has(`${mountId}\0${path}`);
  }
  private save(id: string, entry: Entry): void {
    const previous = this.entries.get(id);
    if (
      previous &&
      this.paths.get(
        `${previous.record.mountId}\0${previous.record.path}`,
      ) === id
    )
      this.paths.delete(
        `${previous.record.mountId}\0${previous.record.path}`,
      );
    this.entries.set(id, entry);
    this.paths.set(
      `${entry.record.mountId}\0${entry.record.path}`,
      id,
    );
  }
  constructor(
    private readonly volume: (
      id: string,
    ) => Promise<VfsVolume>,
    private readonly verification = new DirectoryVerification(),
  ) {}
  has(id: string): boolean {
    return this.entries.has(id);
  }
  directoryIds(mountId: string): string[] {
    return [...this.entries.values()]
      .filter(
        ({ record }) =>
          record.mountId === mountId &&
          record.source === "directory" &&
          record.present !== false,
      )
      .map(({ record }) => record.id);
  }
  register(record: StoredVfsFile): void {
    const previous = this.entries.get(record.id);
    if (
      !previous ||
      previous.missing ||
      (previous.record.mountId === record.mountId &&
        previous.record.path !== record.path)
    )
      this.save(record.id, { record: copy(record) });
    else previous.record.present = record.present;
  }
  absent(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.record.present = false;
  }
  confirmMissing(confirmed: boolean): void {
    for (const entry of this.entries.values())
      if (entry.missing)
        entry.record.present = confirmed
          ? false
          : undefined;
  }
  allocate(id: string, mountId: string): void {
    this.save(id, {
      record: {
        id,
        mountId,
        path: "",
        info: null,
        chunks: {},
        complete: false,
      },
    });
  }
  unavailable(id: string, confirmed = false): void {
    this.save(id, {
      missing: true,
      record: {
        id,
        mountId: "",
        path: "",
        complete: false,
        chunks: {},
        present: confirmed ? false : undefined,
        info: { id, fileName: id, fileSize: 0 },
        error:
          "File's directory is unavailable or the file was moved",
      },
    });
  }
  async create(
    record: StoredVfsFile,
    info: ChunkCacheInfo,
    file?: StoredFile,
    signal?: AbortSignal,
    onProgress?: (progress: FileWriteProgress) => void,
  ): Promise<void> {
    const volume = await this.volume(record.mountId);
    await withExclusiveTask(
      `directory-create:${record.mountId}`,
      async () => {
        signal?.throwIfAborted();
        const name = storageFilename(info.fileName);
        const dot = name.lastIndexOf(".");
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : "";
        let encoded =
          volume.kind === "directory" &&
          decodeDirectoryFilename(name) !== name;
        for (let counter = 0; counter < 10_000; counter++) {
          const candidate = counter
            ? `${stem} (${counter})${extension}`
            : name;
          const destination = encoded
            ? encodeDirectoryFilename(candidate)
            : candidate;
          const partial = !file || !volume.writeFile;
          const path = partial
            ? `${destination}${PARTIAL_SUFFIX}`
            : destination;
          try {
            if (
              (await volume.stat(destination)) ||
              (await volume.stat(
                `${destination}${PARTIAL_SUFFIX}`,
              ))
            )
              continue;
            record.path = path;
            record.info = info;
            // Retain the allocated path in memory so a failed or cancelled import
            // can remove its own new file. No persistent directory index is added.
            this.save(record.id, { record: copy(record) });
            if (file && volume.writeFile) {
              const key = `${record.mountId}\0${path}`;
              this.writingPaths.add(key);
              try {
                const stat = await volume.writeFile(
                  path,
                  file,
                  signal,
                  (bytes) =>
                    onProgress?.({
                      phase: "writing",
                      bytes,
                    }),
                );
                if (
                  info.fingerprint &&
                  contentKey(
                    await this.verification.verify(
                      volume,
                      path,
                      stat,
                      await this.payload(volume, record),
                      { signal, onProgress },
                    ),
                  ) !== contentKey(info.fingerprint)
                )
                  throw new StorageUnavailableError(
                    "File content verification failed",
                  );
                if (
                  (await volume.stat(path))?.revision !==
                  stat.revision
                )
                  throw new StorageUnavailableError(
                    "File changed while verifying completion",
                  );
                record.revision = stat.revision;
                record.complete = true;
                record.verifyContent = true;
                this.save(record.id, {
                  record: copy(record),
                  readRevision: stat.revision,
                });
              } finally {
                this.writingPaths.delete(key);
              }
            } else {
              const key = `${record.mountId}\0${path}`;
              this.writingPaths.add(key);
              try {
                await this.checkpoint(record);
              } finally {
                this.writingPaths.delete(key);
              }
            }
            return;
          } catch (error) {
            signal?.throwIfAborted();
            if (
              volume.kind === "directory" &&
              !encoded &&
              isDirectoryNameBlocked(error)
            ) {
              // Retry this candidate once under an opaque storage extension.
              // Keep actual paths throughout the VFS; only metadata is decoded.
              encoded = true;
              counter--;
              continue;
            }
            if (
              volume.kind === "directory" &&
              !(error instanceof DirectoryWriteError) &&
              !(error instanceof StorageUnavailableError)
            )
              throw new DirectoryWriteError(
                candidate,
                "create",
                error,
              );
            throw error;
          }
        }
        throw new Error("No unused filename is available");
      },
    );
  }
  async identity(record: StoredVfsFile): Promise<string> {
    if (record.source === "directory") return record.id;
    if (!record.complete || !record.info)
      throw new Error("File is not complete");
    const volume = await this.volume(record.mountId);
    const stat = await volume.stat(record.path);
    if (
      !stat ||
      stat.revision !== record.revision ||
      stat.size !== record.info.fileSize
    )
      throw new StorageUnavailableError(
        "File changed while publishing",
      );
    const file = await this.payload(volume, record);
    const entry = await directoryEntry(
      volume,
      record.path,
      stat,
      file,
    );
    this.register(entry);
    return entry.id;
  }
  async fingerprint(
    record: StoredVfsFile,
    file: StoredFile,
    options: FileWriteOptions = {},
    compute?: () => Promise<FileFingerprint>,
  ): Promise<FileFingerprint> {
    const volume = await this.volume(record.mountId);
    const stat = await volume.stat(record.path);
    if (!stat || stat.revision !== record.revision)
      throw new StorageUnavailableError(
        "File changed while identifying its content",
      );
    return this.verification.verify(
      volume,
      record.path,
      stat,
      file,
      options,
      compute,
    );
  }
  async file(
    id: string,
  ): Promise<StoredVfsFile | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const record = copy(entry.record);
    if (
      entry.missing ||
      record.source === "directory" ||
      !record.info
    )
      return record;
    try {
      const volume = await this.volume(record.mountId);
      const stat = await volume.stat(record.path);
      if (!stat || stat.kind !== "file")
        throw new StorageUnavailableError(
          "Stored file is missing",
        );
      if (stat.size === record.info.fileSize) {
        if (!record.complete) {
          record.complete = true;
          record.revision = stat.revision;
        }
        record.verifyContent = true;
        record.error = undefined;
        entry.record = copy(record);
        return record;
      }
      if (
        entry.readRevision === stat.revision &&
        entry.header
      )
        return record;
      const header = await readPartialHeader(
        volume,
        record.path,
        stat.size,
      );
      if (
        header.info.id !== id ||
        header.info.fileSize !== record.info.fileSize
      )
        throw new Error("Partial file identity changed");
      const chunks = await readPartialChunks(
        volume,
        record.path,
        header,
      );
      if (
        (await volume.stat(record.path))?.revision !==
        stat.revision
      )
        throw new Error(
          "Partial file changed while reading its checkpoint",
        );
      const next = {
        ...record,
        info: header.info,
        finalization: header.finalization,
        chunks,
        complete: false,
        revision: undefined,
        error: undefined,
      };
      entry.header = header;
      entry.readRevision = stat.revision;
      entry.record = copy(next);
      return next;
    } catch (error) {
      return {
        ...record,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      };
    }
  }
  async checkpoint(
    record: StoredVfsFile,
    added: readonly (readonly [number, string])[] = [],
    removed: readonly number[] = [],
    options: FileWriteOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    const info = record.info;
    if (!info) throw new Error("File metadata is missing");
    const volume = await this.volume(record.mountId);
    let stat = await volume.stat(record.path);
    let header: PartialHeader;
    if (!stat) {
      stat = await createPartial(volume, record.path, info);
      header = await readPartialHeader(
        volume,
        record.path,
        stat.size,
      );
    } else if (
      stat.size === info.fileSize &&
      record.complete
    ) {
      record.revision = stat.revision;
      this.save(record.id, {
        record: copy(record),
        readRevision: stat.revision,
      });
      return;
    } else {
      header = await readPartialHeader(
        volume,
        record.path,
        stat.size,
      );
      if (
        header.info.id !== record.id ||
        header.info.fileSize !== info.fileSize ||
        header.info.chunkSize !== info.chunkSize
      )
        throw new StorageUnavailableError(
          "Partial file identity changed",
        );
    }
    if (record.complete) {
      const fingerprint = await this.verification.verify(
        volume,
        record.path,
        stat,
        await this.payload(volume, record),
        options,
      );
      if (
        info.fingerprint &&
        contentKey(fingerprint) !==
          contentKey(info.fingerprint)
      )
        throw new StorageUnavailableError(
          "File content verification failed",
        );
      const verifiedStat = stat;
      options.signal?.throwIfAborted();
      stat = await withExclusiveTask(
        `directory-create:${record.mountId}`,
        async () => {
          options.signal?.throwIfAborted();
          this.finalizing.add(record.mountId);
          this.version++;
          try {
            return await finalizeDirectoryFile(
              volume,
              record,
              header,
              () => {
                // Publish the path before another operation can observe the moved file.
                this.save(record.id, {
                  record: {
                    ...copy(record),
                    complete: false,
                    revision: undefined,
                  },
                });
              },
              this.verification,
              verifiedStat,
              fingerprint,
              options,
            );
          } finally {
            this.finalizing.delete(record.mountId);
            this.version++;
          }
        },
      );
      record.revision = stat.revision;
      record.finalization = undefined;
      record.verifyContent = true;
      this.save(record.id, {
        record: copy(record),
        readRevision: stat.revision,
      });
      return;
    }
    const writes = chunkCheckpointWrites(
      info,
      added,
      removed,
    );
    if (
      JSON.stringify(header.info) !== JSON.stringify(info)
    ) {
      const generation = header.generation + 1;
      writes.push({
        offset:
          header.metadataOffset +
          (generation % 2) * PARTIAL_SLOT_BYTES,
        data: await metadataSlot(
          info,
          generation,
          header.finalization,
        ),
      });
      header = {
        ...header,
        info: snapshotFileMetadata(info),
        generation,
      };
    }
    if (writes.length)
      stat = await volume.commit(record.path, writes);
    record.revision = stat.revision;
    this.save(record.id, {
      record: copy(record),
      readRevision: stat.revision,
      header,
    });
  }
  async removeFile(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (
      entry &&
      this.paths.get(
        `${entry.record.mountId}\0${entry.record.path}`,
      ) === id
    ) {
      this.paths.delete(
        `${entry.record.mountId}\0${entry.record.path}`,
      );
      this.verification.forget(
        entry.record.mountId,
        entry.record.path,
        entry.record.revision,
      );
    }
    this.entries.delete(id);
  }

  private async payload(
    volume: VfsVolume,
    record: StoredVfsFile,
  ) {
    const info = record.info!;
    const file = await volume.file(record.path, {
      name: info.fileName,
      type: info.mimetype ?? "",
      lastModified: info.lastModified ?? 0,
    });
    if (file.size === info.fileSize) return file;
    if (file instanceof Blob)
      return new File(
        [(file as Blob).slice(0, info.fileSize)],
        file.name,
        {
          type: file.type,
          lastModified: file.lastModified,
        },
      );
    return new RangeFile(
      file.name,
      info.fileSize,
      file.type,
      file.lastModified,
      (offset, length) =>
        file.slice(offset, offset + length).arrayBuffer(),
    );
  }
  /** The existing ChunkCache sees payload offsets; trailer I/O stays inside this store. */
  async payloadVolume(id: string): Promise<VfsVolume> {
    const volume = await this.volume(id);
    const find = (path: string) =>
      this.entries.get(
        this.paths.get(`${id}\0${path}`) ?? "",
      )?.record;
    return {
      id: volume.id,
      name: volume.name,
      kind: volume.kind,
      capabilities: volume.capabilities,
      list: (path) => volume.list(path),
      watch: (changed) => volume.watch(changed),
      remove: (path) => volume.remove(path),
      stat: async (path) => {
        const stat = await volume.stat(path);
        const record = find(path);
        if (
          stat?.kind === "file" &&
          record?.info &&
          record.source !== "directory" &&
          stat.size >= record.info.fileSize
        )
          return { ...stat, size: record.info.fileSize };
        return stat;
      },
      read: (path, offset, length) =>
        volume.read(path, offset, length),
      commit: async (path, writes) => {
        const record = find(path);
        if (!record?.info)
          throw new Error("File metadata is missing");
        const stat = writes.length
          ? await volume.commit(path, writes)
          : await volume.stat(path);
        if (!stat)
          throw new StorageUnavailableError(
            "Stored file is missing",
          );
        return { ...stat, size: record.info.fileSize };
      },
      file: async (path, metadata) => {
        const record = find(path);
        return record?.source !== "directory" &&
          record?.info
          ? this.payload(volume, record)
          : volume.file(path, metadata);
      },
    };
  }
}
