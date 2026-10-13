import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import type { FileSaveOptions } from "@weblink/platform";

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
  file: Blob,
  name: string,
  options?: FileSaveOptions,
): Promise<boolean> {
  if (platform.saveFile)
    return platform.saveFile(file, name, options);
  const url = URL.createObjectURL(file);
  try {
    clickDownload(url, name);
  } finally {
    // Let the browser consume the URL before releasing large received files.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
  return true;
}

function report(error: unknown): void {
  console.error("Could not save file", error);
  toast.error(t("common.notification.file_save_failed"));
}

export function downloadFile(
  file: File,
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
    const response = await fetch(url);
    if (!response.ok)
      throw new Error("File content is unavailable");
    await saveFile(
      await response.blob(),
      name || "download",
    );
  })().catch(report);
}
