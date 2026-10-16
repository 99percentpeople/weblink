import { invoke } from "@tauri-apps/api/core";
import type { StoredFile } from "@weblink/platform";
import { writeNativeFile } from "./save-file";

function capability(url: string): string {
  const parsed = new URL(url);
  const native =
    (parsed.protocol === "weblink-file:" &&
      parsed.hostname === "localhost") ||
    (["http:", "https:"].includes(parsed.protocol) &&
      parsed.hostname === "weblink-file.localhost");
  const id = parsed.pathname.slice(1);
  if (
    !native ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^[a-zA-Z0-9-]+$/.test(id)
  )
    throw new Error("Invalid native file capability");
  return id;
}

export async function openNativeFile(
  file: StoredFile,
): Promise<void> {
  if (file.url) {
    await invoke("vfs_open_file", {
      id: capability(file.url),
    });
    return;
  }
  // Legacy IndexedDB/browser files have no host path. Stage bounded bytes without
  // a save dialog; the native finish opens only after the entire file is committed.
  const id = await invoke<string>("file_open_begin", {
    name: file.name,
    size: file.size,
  });
  await writeNativeFile(file, id);
}
