import { LocalFileSystemError } from "@weblink/platform";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import {
  DirectoryWriteError,
  StorageUnavailableError,
} from "@/libs/domain/vfs";
import { userErrorMessage } from "@/libs/user-error";
import { localFileErrorDetail } from "@/libs/utils/local-file-error";
import { copyText } from "@/libs/utils/copy-text";

function localStorageCause(
  error: unknown,
): Error | undefined {
  const seen = new Set<unknown>();
  for (let depth = 0; error && depth < 5; depth++) {
    if (seen.has(error)) return;
    seen.add(error);
    if (
      error instanceof LocalFileSystemError ||
      error instanceof DirectoryWriteError ||
      error instanceof StorageUnavailableError
    )
      return error;
    if (!(error instanceof Error)) return;
    // Only local preparation failures may carry filesystem diagnostics through
    // the protocol boundary. Remote error text stays behind the translated UI.
    const code = (error as Error & { code?: string }).code;
    if (code && code !== "prepare-failed") return;
    error = error.cause;
  }
}

export function showFileOperationError(
  error: unknown,
): void {
  const local = localStorageCause(error);
  const title = userErrorMessage(
    local ?? error,
    "errors.file_failed",
  );
  const description =
    local instanceof LocalFileSystemError
      ? local.message
      : local && localFileErrorDetail(local);
  if (!description) {
    toast.error(title);
    return;
  }
  const details = `${title}\n${description}`;
  toast.error(title, {
    description,
    classNames: {
      description:
        "max-h-48 overflow-y-auto whitespace-pre-wrap break-words select-text",
    },
    duration: 30000,
    closeButton: true,
    action: {
      label: t("file_import_error.copy_details"),
      onClick: (event) => {
        event.preventDefault();
        void copyText(details).then((copied) => {
          if (copied)
            toast.success(
              t("common.notification.copy_success"),
            );
          else
            toast.error(
              t("common.notification.copy_failed"),
            );
        });
      },
    },
  });
}
