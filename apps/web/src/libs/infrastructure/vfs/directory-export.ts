import {
  resolveFileSaveConflict,
  runFileSaveBatch,
  type FileBatchSaveOptions,
  type FileConflictResolver,
  type FileSaveOutcome,
  type StoredFile,
} from "@weblink/platform";
import {
  DirectoryWriteError,
  storageFilename,
} from "@/libs/domain/vfs";
import {
  decodeDirectoryFilename,
  encodeDirectoryFilename,
  isDirectoryNameBlocked,
} from "./directory-filename";
import { DirectoryVolume } from "./directory-volume";

/** A temporary export destination, never a persisted cache mount. */
export async function exportDirectoryFiles(
  directory: FileSystemDirectoryHandle,
  files: readonly StoredFile[],
  resolveConflict: FileConflictResolver,
  options?: FileBatchSaveOptions,
): Promise<boolean> {
  const volume = new DirectoryVolume(
    "export",
    directory.name,
    directory,
  );
  return runFileSaveBatch(
    files,
    (file, onWritten) =>
      exportFile(
        volume,
        file,
        resolveConflict,
        options?.signal,
        onWritten,
      ),
    options,
  );
}

async function exportFile(
  volume: DirectoryVolume,
  file: StoredFile,
  resolveConflict: FileConflictResolver,
  signal?: AbortSignal,
  onWritten?: (bytes: number) => void,
): Promise<FileSaveOutcome> {
  const name = storageFilename(file.name);
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  let encoded = decodeDirectoryFilename(name) !== name;
  let keepBoth = false;
  for (let counter = 0; counter < 10_000; counter++) {
    const candidate = counter
      ? `${stem} (${counter})${extension}`
      : name;
    const path = encoded
      ? encodeDirectoryFilename(candidate)
      : candidate;
    let creating = false;
    try {
      signal?.throwIfAborted();
      const existing = await volume.stat(path);
      signal?.throwIfAborted();
      if (existing) {
        if (keepBoth) continue;
        const action = await resolveFileSaveConflict(
          resolveConflict,
          {
            fileName: candidate,
            canOverwrite: existing.kind === "file",
          },
          signal,
        );
        signal?.throwIfAborted();
        if (action === null) return "cancelled";
        if (action === "skip") return "skipped";
        if (action === "keep_both") {
          keepBoth = true;
          continue;
        }
        if (existing.kind !== "file")
          throw new Error(
            "Cannot overwrite a directory with a file",
          );
      }
      creating = !existing;
      await volume.writeFile(path, file, signal, onWritten);
      return "saved";
    } catch (error) {
      // Failed replacements retain the original; only new exports are removed.
      if (creating)
        await volume.remove(path).catch(() => {});
      signal?.throwIfAborted();
      if (!encoded && isDirectoryNameBlocked(error)) {
        encoded = true;
        counter--;
        continue;
      }
      throw error instanceof DirectoryWriteError
        ? error
        : new DirectoryWriteError(
            file.name,
            "create",
            error,
          );
    }
  }
  throw new Error("No unused filename is available");
}
