import { invoke } from "@tauri-apps/api/core";
import {
  resolveFileSaveConflict,
  runFileSaveBatch,
  type FileBatchSaveOptions,
  type FileSaveOptions,
  type FileConflictResolver,
  type FileSaveConflict,
  type StoredFile,
} from "@weblink/platform";

const CHUNK_BYTES = 1024 * 1024;
let pending: Promise<unknown> = Promise.resolve();

type DirectorySaveBegin =
  | { status: "ready"; id: string }
  | ({ status: "conflict" } & FileSaveConflict);

/** Serialize native pickers and keep large files out of JSON/base64 IPC. */
export function saveNativeFile(
  file: import("@weblink/platform").BinarySource,
  name: string,
  options?: FileSaveOptions,
): Promise<boolean> {
  const next = pending.then(() =>
    save(file, name, options?.automatic === true),
  );
  pending = next.catch(() => undefined);
  return next;
}

/** Keep the selected directory scoped to this batch, without mounting it as storage. */
export function saveNativeFilesToDirectory(
  files: readonly StoredFile[],
  resolveConflict: FileConflictResolver,
  options?: FileBatchSaveOptions,
): Promise<boolean> {
  if (!files.length) return Promise.resolve(true);
  const signal = options?.signal;
  const next = pending.then(async () => {
    if (signal?.aborted) return false;
    const directoryId = await invoke<string | null>(
      "file_save_directory_pick",
    );
    if (directoryId === null) return false;
    try {
      return await runFileSaveBatch(
        files,
        async (file, onWritten) => {
          const request = {
            name: file.name,
            size: file.size,
            directoryId,
          };
          let result = await invoke<DirectorySaveBegin>(
            "file_save_directory_begin",
            request,
          );
          while (result.status === "conflict") {
            const action = await resolveFileSaveConflict(
              resolveConflict,
              {
                fileName: result.fileName,
                canOverwrite: result.canOverwrite,
              },
              signal,
            );
            signal?.throwIfAborted();
            if (action === null) return "cancelled";
            if (action === "skip") return "skipped";
            if (
              action === "overwrite" &&
              !result.canOverwrite
            )
              throw new Error(
                "Cannot overwrite this destination with a file",
              );
            result = await invoke<DirectorySaveBegin>(
              "file_save_directory_begin",
              { ...request, action },
            );
          }
          await writeNativeFile(file, result.id, {
            signal,
            onWritten,
          });
          return "saved";
        },
        options,
      );
    } finally {
      await invoke("file_save_directory_release", {
        id: directoryId,
      });
    }
  });
  pending = next.catch(() => undefined);
  return next;
}

async function save(
  file: import("@weblink/platform").BinarySource,
  name: string,
  automatic: boolean,
): Promise<boolean> {
  const id = await invoke<string | null>(
    "file_save_begin",
    { name, size: file.size, automatic },
  );
  if (id === null) return false;
  await writeNativeFile(file, id);
  return true;
}

/** Complete a native save/open session; failures release its temporary bytes. */
export async function writeNativeFile(
  file: import("@weblink/platform").BinarySource,
  id: string,
  options?: {
    signal?: AbortSignal;
    onWritten?: (bytes: number) => void;
  },
): Promise<void> {
  let finished = false;
  try {
    for (
      let offset = 0;
      offset < file.size;
      offset += CHUNK_BYTES
    ) {
      options?.signal?.throwIfAborted();
      const bytes = await file
        .slice(offset, offset + CHUNK_BYTES)
        .arrayBuffer();
      options?.signal?.throwIfAborted();
      await invoke("file_save_write", bytes, {
        headers: {
          "x-save-id": id,
          "x-save-offset": String(offset),
        },
      });
      options?.onWritten?.(offset + bytes.byteLength);
    }
    options?.signal?.throwIfAborted();
    await invoke("file_save_finish", { id });
    finished = true;
  } finally {
    if (!finished) {
      await invoke("file_save_abort", { id }).catch(
        (error: unknown) => {
          console.warn(
            "Could not clean up cancelled file save",
            error,
          );
        },
      );
    }
  }
}
