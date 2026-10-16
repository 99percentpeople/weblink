import type {
  FileStorageLocation,
  StoredFile,
} from "@weblink/platform";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { downloadFile, saveFileAs } from "./download-file";

/** Use the file's own storage, which can differ from the current default. */
export function fileSaveAction(
  kind?: FileStorageLocation["kind"],
): { label: string; save(file: StoredFile): void } {
  const directory =
    kind === "directory" || kind === "native";
  return {
    label: t(
      directory
        ? "file_library.action_save_as"
        : "file_library.action_download",
    ),
    save(file) {
      if (!directory) {
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
