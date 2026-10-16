import type {
  BinarySource,
  FileBatchSaveOptions,
  FileConflictResolver,
  StoredFile,
} from "@weblink/platform";
import {
  materializeBlob,
  sourceForFileUrl,
} from "./stored-file";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import type { FileSaveOptions } from "@weblink/platform";
import { exportDirectoryFiles } from "@/libs/infrastructure/vfs/directory-export";

function clickDownload(url: string, name: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
  }
}

/** False represents a cancelled native save dialog, not a failed download. */
export async function saveFile(
  file: BinarySource,
  name: string,
  options?: FileSaveOptions,
): Promise<boolean> {
  if (platform.saveFile)
    return platform.saveFile(file, name, options);
  const url = URL.createObjectURL(
    await materializeBlob(file),
  );
  try {
    clickDownload(url, name);
  } finally {
    // Let the browser consume the URL before releasing large received files.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

async function pickSaveFile(
  file: StoredFile,
): Promise<FileSystemFileHandle | null> {
  try {
    return await window.showSaveFilePicker({
      suggestedName: file.name,
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    )
      return null;
    throw error;
  }
}

async function writePickedFile(
  file: StoredFile,
  handle: FileSystemFileHandle,
): Promise<void> {
  const writable = await handle.createWritable();
  try {
    await file.stream().pipeTo(writable);
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  }
}

/** Start the picker in the click handler, before any asynchronous file reads. */
export async function saveFileAs(
  file: StoredFile,
): Promise<boolean> {
  if (platform.saveFile)
    return saveFile(file, file.name, { automatic: false });
  if (typeof window.showSaveFilePicker !== "function")
    return saveFile(file, file.name);
  const handle = await pickSaveFile(file);
  if (!handle) return false;
  await writePickedFile(file, handle);
  return true;
}

/** Pick one directory for the entire batch; false means cancellation. */
export async function saveFilesAs(
  files: readonly StoredFile[],
  resolveConflict: FileConflictResolver,
  options?: FileBatchSaveOptions,
): Promise<boolean> {
  if (!files.length) return true;
  if (options?.signal?.aborted) return false;
  if (platform.saveFilesToDirectory)
    return platform.saveFilesToDirectory(
      files,
      resolveConflict,
      options,
    );
  if (typeof window.showDirectoryPicker !== "function")
    throw new Error("Directory selection is unavailable");
  let directory: FileSystemDirectoryHandle;
  try {
    directory = await window.showDirectoryPicker({
      mode: "readwrite",
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    )
      return false;
    throw error;
  }
  if (options?.signal?.aborted) return false;
  return exportDirectoryFiles(
    directory,
    files,
    resolveConflict,
    options,
  );
}

function report(error: unknown): void {
  console.error("Could not save file", error);
  toast.error(t("common.notification.file_save_failed"));
}

export function downloadFile(
  file: StoredFile,
  options?: FileSaveOptions,
): void {
  void saveFile(file, file.name, options).catch(report);
}

/** Gallery content already has an object URL; desktop saves its bytes locally. */
export function downloadUrl(
  url: string,
  name: string,
): void {
  if (!platform.saveFile) {
    clickDownload(url, name);
    return;
  }
  void (async () => {
    const source = sourceForFileUrl(url);
    if (source) {
      await saveFile(source, name || source.name);
      return;
    }
    const response = await fetch(url);
    if (!response.ok)
      throw new Error("File content is unavailable");
    await saveFile(
      await response.blob(),
      name || "download",
    );
  })().catch(report);
}
