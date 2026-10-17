import type { StoredFile } from "@weblink/platform";
import type { FileCapabilities } from "@/libs/domain/file-storage";
import type { ChunkCache } from "@/libs/domain/file";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { downloadFile, saveFileAs } from "./download-file";

/** Use the file's own storage, which can differ from the current default. */
export function fileSaveAction(
  capabilities?: FileCapabilities,
): { label: string; save(file: StoredFile): void } {
  const saveAs = capabilities?.save === "save-as";
  return {
    label: t(
      saveAs
        ? "file_library.action_save_as"
        : "file_library.action_download",
    ),
    save(file) {
      if (!saveAs) {
        downloadFile(file, { automatic: true });
        return;
      }
      // Start the picker synchronously within the click's user activation.
      void saveFileAs(file).catch((error) => {
        console.error("Could not save file", error);
        toast.error(
          t("common.notification.file_save_failed"),
        );
      });
    },
  };
}

export async function revealFile(
  cache: ChunkCache | null | undefined,
): Promise<void> {
  if (!cache?.reveal)
    throw new Error("File location is unavailable");
  await cache.reveal();
}
