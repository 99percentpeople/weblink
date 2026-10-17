import type { VfsVolume } from "@weblink/platform";
import {
  vfsPath,
  StorageUnavailableError,
} from "@/libs/domain/vfs";
import type { StoredVfsFile } from "./database";
import { directoryEntry } from "./directory-entry";
import { DirectoryVerification } from "./directory-verification";
import { isHiddenDirectoryEntry } from "./directory-visibility";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import {
  hasPartialTrailer,
  readPartialHeader,
  readPartialChunks,
} from "./partial-file";

/** Reads the directory directly. The result is disposable; nothing is indexed on disk. */
export async function scanDirectory(
  volume: VfsVolume,
  signal: AbortSignal,
  isWriting: (path: string) => boolean = () => false,
  verification = new DirectoryVerification(),
): Promise<StoredVfsFile[]> {
  if ((await volume.stat(""))?.kind !== "directory")
    throw new StorageUnavailableError(
      "Storage directory is unavailable",
    );
  const result: StoredVfsFile[] = [];
  const ids = new Map<string, number>();
  const visit = async (parent: string): Promise<void> => {
    for (const stat of await volume.list(parent)) {
      signal.throwIfAborted();
      // Apply equally to native and browser mounts, before entering folders or
      // opening files. Hidden directory trees can contain thousands of entries.
      if (isHiddenDirectoryEntry(stat.name)) continue;
      const path = vfsPath(
        parent ? `${parent}/${stat.name}` : stat.name,
      );
      if (stat.kind === "directory") {
        await visit(path);
        continue;
      }
      if (isWriting(path)) continue;
      const file = await volume.file(path, {
        name: stat.name,
        type: "",
        lastModified: stat.modified,
      });
      if (
        (await volume.stat(path))?.revision !==
          stat.revision ||
        file.size !== stat.size
      )
        throw new StorageUnavailableError(
          "Directory changed while scanning",
        );
      let record = await directoryEntry(
        volume,
        path,
        stat,
        file,
      );
      if (
        !record.draft &&
        (await hasPartialTrailer(volume, path, stat.size))
      ) {
        try {
          const header = await readPartialHeader(
            volume,
            path,
            stat.size,
          );
          record = {
            id: header.info.id,
            mountId: volume.id,
            path,
            info: header.info,
            finalization: header.finalization,
            complete: false,
            chunks: {},
            present: true,
          };
        } catch (reason) {
          record.complete = false;
          record.error =
            reason instanceof Error
              ? reason.message
              : String(reason);
        }
      }
      if (
        (await volume.stat(path))?.revision !==
        stat.revision
      )
        throw new StorageUnavailableError(
          "Directory changed while scanning",
        );
      const previousIndex = ids.get(record.id);
      if (previousIndex !== undefined) {
        const previous = result[previousIndex];
        const state = record.finalization;
        if (
          !state ||
          previous.finalization?.source !== state.source ||
          previous.finalization.target !== state.target ||
          ![state.source, state.target].includes(
            previous.path,
          ) ||
          ![state.source, state.target].includes(
            record.path,
          )
        )
          throw new Error(
            "Duplicate storage identity in directory",
          );
        // A browser copy or native link may commit before its old name is removed.
        // Keep the resumable source authoritative until completion verifies the copy.
        if (record.path === state.source)
          result[previousIndex] = record;
        continue;
      }
      ids.set(record.id, result.length);
      result.push(record);
    }
  };
  await visit("");
  signal.throwIfAborted();
  // A browser can finish its final write before a crash prevents temporary cleanup.
  // Hide only a verified copy belonging to a fully checkpointed source, never a name collision.
  const hidden = new Set<string>();
  const byPath = new Map(
    result.map((record) => [record.path, record]),
  );
  for (const source of result) {
    if (
      source.path !== source.finalization?.source ||
      !source.info
    )
      continue;
    const target = byPath.get(source.finalization.target);
    if (
      target?.source !== "directory" ||
      !target.complete ||
      target.info?.fileSize !== source.info.fileSize
    )
      continue;
    const before = await volume.stat(source.path);
    if (!before)
      throw new StorageUnavailableError(
        "Temporary file disappeared while scanning",
      );
    const header = await readPartialHeader(
      volume,
      source.path,
      before.size,
    );
    const chunks = await readPartialChunks(
      volume,
      source.path,
      header,
    );
    if (
      Object.keys(chunks).length !==
      Math.ceil(
        source.info.fileSize / source.info.chunkSize!,
      )
    )
      continue;
    const metadata = {
      name: source.info.fileName,
      type: "",
      lastModified: 0,
    };
    const expected = await verification.verify(
      volume,
      source.path,
      before,
      (await volume.file(source.path, metadata)).slice(
        0,
        source.info.fileSize,
      ),
      { signal },
    );
    if (
      source.info.fingerprint &&
      contentKey(source.info.fingerprint) !==
        contentKey(expected)
    )
      continue;
    const targetStat = await volume.stat(target.path);
    if (
      !targetStat ||
      targetStat.revision !== target.revision
    )
      throw new StorageUnavailableError(
        "Directory changed while recovering completion",
      );
    const actual = await verification.verify(
      volume,
      target.path,
      targetStat,
      await volume.file(target.path, metadata),
      { signal },
    );
    if (
      (await volume.stat(source.path))?.revision !==
        before.revision ||
      (await volume.stat(target.path))?.revision !==
        target.revision
    )
      throw new StorageUnavailableError(
        "Directory changed while recovering completion",
      );
    if (contentKey(actual) === contentKey(expected))
      hidden.add(target.id);
  }
  return result.filter((record) => !hidden.has(record.id));
}
