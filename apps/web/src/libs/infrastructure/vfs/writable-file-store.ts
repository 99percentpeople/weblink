import type {
  StoredFile,
  VfsVolume,
  VfsStat,
  VfsWrite,
} from "@weblink/platform";
import type { WritableStoredFile } from "@/libs/domain/file-storage";
import { createUuid } from "@/libs/domain/ids";
import { storageFilename } from "@/libs/domain/vfs";
import { withExclusiveTask } from "@/libs/utils/exclusive-task";
import {
  VfsDatabase,
  type StoredVfsFile,
} from "./database";
import { DirectoryFileStore } from "./directory-file-store";
import { DirectoryVerification } from "./directory-verification";
import {
  directoryEntry,
  RECORDING_SUFFIX,
} from "./directory-entry";

/** Generated files have no declared final size and never use transfer checkpoints. */
export class WritableFileStore {
  private readonly active = new Map<
    string,
    StoredVfsFile
  >();
  private readonly publishing = new Set<string>();
  private readonly sessions = new Set<WritableStoredFile>();
  constructor(
    private readonly database: VfsDatabase,
    private readonly directories: DirectoryFileStore,
    private readonly verification: DirectoryVerification,
    private readonly changed: (mountId: string) => void,
  ) {}
  isWriting(mountId: string, path: string): boolean {
    const key = `${mountId}\0${path}`;
    return this.active.has(key) || this.publishing.has(key);
  }
  records(mountId: string): StoredVfsFile[] {
    return [...this.active.values()].filter(
      (record) => record.mountId === mountId,
    );
  }
  async dispose(): Promise<void> {
    await Promise.allSettled(
      [...this.sessions].map((session) => session.abort()),
    );
  }
  async create(
    volume: VfsVolume,
    options: {
      name: string;
      type: string;
      signal?: AbortSignal;
    },
  ): Promise<WritableStoredFile> {
    options.signal?.throwIfAborted();
    if (!volume.openWriter)
      throw new Error("This storage cannot record files");
    let name = storageFilename(options.name);
    const uuid = createUuid();
    const indexed = volume.kind === "indexeddb";
    const path = indexed
      ? `recordings/${uuid}`
      : `${name}.${uuid}${RECORDING_SUFFIX}`;
    const writer = await volume.openWriter(path);
    const key = `${volume.id}\0${path}`;
    const metadata = {
      name,
      type: options.type,
      lastModified: Date.now(),
    };
    const fileAt = (target: string) =>
      volume.file(target, metadata);
    let record: StoredVfsFile;
    try {
      const stat = await volume.stat(path);
      if (!stat)
        throw new Error("Recording file is unavailable");
      record = indexed
        ? {
            id: `recording_${uuid}`,
            mountId: volume.id,
            path,
            chunks: {},
            complete: false,
            draft: "recording",
            revision: stat.revision,
            info: {
              id: `recording_${uuid}`,
              fileName: name,
              fileSize: 0,
              mimetype: metadata.type,
              chunkSize: 256 * 1024,
              libraryPinned: true,
            },
          }
        : await directoryEntry(
            volume,
            path,
            stat,
            await fileAt(path),
          );
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    const publishRecord = async () => {
      if (indexed)
        await this.database.put("files", record.id, record);
      else this.directories.register(record);
      this.changed(volume.id);
    };
    this.active.set(key, record);
    let ending = false;
    let finished = false;
    let queue = Promise.resolve();
    let finishing:
      | ReturnType<WritableStoredFile["finish"]>
      | undefined;
    let aborting: Promise<void> | undefined;
    const detach = () => {
      this.active.delete(key);
      this.sessions.delete(session);
      options.signal?.removeEventListener("abort", abort);
      this.changed(volume.id);
    };
    const refreshDraft = async (force = false) => {
      // Browser streams do not expose new bytes until close. Re-statting and
      // notifying after every block triggers full-library scans of unchanged data.
      if (!force && volume.capabilities.commit === "close")
        return;
      const stat = await volume.stat(path);
      if (!stat) return;
      if (
        record.revision === stat.revision &&
        record.info?.fileSize === stat.size
      )
        return;
      record.revision = stat.revision;
      record.info = {
        ...record.info!,
        fileSize: stat.size,
      };
      await publishRecord();
    };
    const finish = async (
      patches: readonly VfsWrite[],
      finalMetadata?: { name: string; type: string },
    ) => {
      await queue;
      options.signal?.throwIfAborted();
      if (finalMetadata) {
        name = storageFilename(finalMetadata.name);
        metadata.name = name;
        metadata.type = finalMetadata.type;
        record.info = {
          ...record.info!,
          fileName: name,
          mimetype: metadata.type,
        };
      }
      let stat = await writer.close(patches);
      if (!stat.size)
        throw new Error("Recording produced no data");
      let file = await fileAt(path);
      const fingerprint = await this.verification.verify(
        volume,
        path,
        stat,
        file,
        { signal: options.signal },
      );
      if (indexed) {
        const complete: StoredVfsFile = {
          ...record,
          complete: true,
          draft: undefined,
          revision: stat.revision,
          info: {
            ...record.info!,
            fileName: name,
            fileSize: stat.size,
            lastModified: metadata.lastModified,
          },
        };
        await this.database.put(
          "files",
          complete.id,
          complete,
        );
        record = complete;
        this.changed(volume.id);
      } else {
        record = await withExclusiveTask(
          `directory-create:${volume.id}`,
          async () => {
            const dot = name.lastIndexOf(".");
            const stem =
              dot > 0 ? name.slice(0, dot) : name;
            const extension =
              dot > 0 ? name.slice(dot) : "";
            for (let index = 0; index < 10000; index++) {
              options.signal?.throwIfAborted();
              const target = index
                ? `${stem} (${index})${extension}`
                : name;
              if (await volume.stat(target)) continue;
              const targetKey = `${volume.id}\0${target}`;
              this.publishing.add(targetKey);
              try {
                let result: VfsStat;
                if (volume.move) {
                  const moved = await volume.move(
                    path,
                    target,
                    stat.revision,
                  );
                  if (!moved) continue;
                  result = moved;
                  this.verification.remember(
                    volume,
                    target,
                    result,
                    fingerprint,
                  );
                } else {
                  const output =
                    await volume.openWriter!(target);
                  try {
                    const reader = file
                      .stream()
                      .getReader();
                    try {
                      while (true) {
                        options.signal?.throwIfAborted();
                        const part = await reader.read();
                        if (part.done) break;
                        await output.write(part.value);
                      }
                    } finally {
                      await reader.cancel().catch(() => {});
                      reader.releaseLock();
                    }
                    result = await output.close();
                    const copied =
                      await this.verification.verify(
                        volume,
                        target,
                        result,
                        await fileAt(target),
                        { signal: options.signal },
                      );
                    if (
                      copied.digest !==
                        fingerprint.digest ||
                      copied.size !== fingerprint.size
                    )
                      throw new Error(
                        "Recording changed while saving",
                      );
                  } catch (error) {
                    await output.abort().catch(() => {});
                    await volume
                      .remove(target)
                      .catch(() => {});
                    throw error;
                  }
                  if (
                    (await volume.stat(path))?.revision !==
                    stat.revision
                  )
                    throw new Error(
                      "Recording draft changed while saving",
                    );
                  await volume.remove(path);
                }
                const published = await volume.file(
                  target,
                  { ...metadata, name: target },
                );
                const next = await directoryEntry(
                  volume,
                  target,
                  result,
                  published,
                );
                this.directories.register(next);
                this.verification.forget(volume.id, path);
                file = published;
                return next;
              } finally {
                this.publishing.delete(targetKey);
              }
            }
            throw new Error(
              "No unused recording filename is available",
            );
          },
        );
      }
      finished = true;
      detach();
      return { id: record.id, file };
    };
    const session: WritableStoredFile = {
      mountId: volume.id,
      write: (bytes) => {
        if (ending)
          return Promise.reject(
            new Error("Recording writer is closed"),
          );
        const data = bytes.slice();
        const next = queue.then(async () => {
          options.signal?.throwIfAborted();
          await writer.write(data);
          await refreshDraft();
        });
        queue = next;
        void next.catch(() => {});
        return next;
      },
      finish: (patches = [], finalMetadata) => {
        if (aborting)
          return Promise.reject(
            new Error("Recording was aborted"),
          );
        ending = true;
        return (finishing ??= finish(
          patches.map(({ offset, data }) => ({
            offset,
            data: data.slice(),
          })),
          finalMetadata && { ...finalMetadata },
        ).catch(async (error) => {
          await writer.abort().catch(() => {});
          await refreshDraft(true).catch(() => {});
          detach();
          throw error;
        }));
      },
      abort: () => {
        ending = true;
        return (aborting ??= (async () => {
          await (finishing ?? queue).catch(() => {});
          if (!finished) {
            await writer.abort();
            await refreshDraft(true);
          }
        })().finally(detach));
      },
    };
    const abort = () => {
      void session.abort().catch(() => {});
    };
    this.sessions.add(session);
    options.signal?.addEventListener("abort", abort, {
      once: true,
    });
    try {
      await publishRecord();
      options.signal?.throwIfAborted();
      return session;
    } catch (error) {
      await session.abort().catch(() => {});
      throw error;
    }
  }
}
