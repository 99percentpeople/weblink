import { invoke } from "@tauri-apps/api/core";
import type { FileSaveOptions } from "@weblink/platform";

const CHUNK_BYTES = 1024 * 1024;
let pending: Promise<unknown> = Promise.resolve();

/** Serialize native pickers and keep large files out of JSON/base64 IPC. */
export function saveNativeFile(
  file: Blob,
  name: string,
  options?: FileSaveOptions,
): Promise<boolean> {
  const next = pending.then(() =>
    save(file, name, options?.automatic === true),
  );
  pending = next.catch(() => undefined);
  return next;
}

async function save(
  file: Blob,
  name: string,
  automatic: boolean,
): Promise<boolean> {
  const id = await invoke<string | null>(
    "file_save_begin",
    { name, size: file.size, automatic },
  );
  if (id === null) return false;
  let finished = false;
  try {
    for (
      let offset = 0;
      offset < file.size;
      offset += CHUNK_BYTES
    ) {
      const bytes = await file
        .slice(offset, offset + CHUNK_BYTES)
        .arrayBuffer();
      await invoke("file_save_write", bytes, {
        headers: {
          "x-save-id": id,
          "x-save-offset": String(offset),
        },
      });
    }
    await invoke("file_save_finish", { id });
    finished = true;
    return true;
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
