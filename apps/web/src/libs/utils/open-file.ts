import type { StoredFile } from "@weblink/platform";
import { platform } from "@/libs/platform/runtime";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

export const fileOpenLabel = (): string =>
  t(
    platform.openFile
      ? "common.action.open"
      : "common.action.preview",
  );

/** Native file actions report failures here because several callers are event handlers. */
export async function openFileExternally(
  file: StoredFile,
): Promise<void> {
  try {
    if (!platform.openFile)
      throw new Error("System file opening is unavailable");
    await platform.openFile(file);
  } catch (error) {
    console.error("Could not open file", error);
    toast.error(t("common.notification.file_open_failed"));
  }
}
