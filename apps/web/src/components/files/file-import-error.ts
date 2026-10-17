import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import type { FileImportProgress } from "@/libs/application/file-library-service";
import { userErrorMessage } from "@/libs/user-error";
import { copyText } from "@/libs/utils/copy-text";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { localFileErrorDetail } from "@/libs/utils/local-file-error";

export type FileImportStage =
  | FileImportProgress["phase"]
  | "preparing"
  | "authorizing"
  | "sharing";

export function showFileImportError(
  error: unknown,
  context: {
    stage: FileImportStage;
    file?: Pick<File, "name" | "size">;
    completed?: number;
    total?: number;
  },
): void {
  const directoryError =
    error instanceof DirectoryWriteError;
  const title = directoryError
    ? userErrorMessage(error)
    : t("file_import_error.title");
  const fileName =
    context.file?.name ??
    (directoryError ? error.fileName : undefined);
  const stage = directoryError
    ? t(`storage.stage_${error.stage}`)
    : t(`file_import_error.${context.stage}`);
  const description = [
    fileName &&
      (context.file
        ? `${fileName} (${formatBtyeSize(context.file.size)})`
        : fileName),
    t("file_import_error.stage", { stage }),
    context.total !== undefined &&
      t("file_import_progress.counts", {
        completed: context.completed ?? 0,
        total: context.total,
      }),
    localFileErrorDetail(
      directoryError ? error.cause : error,
    ) ?? t("file_import_error.unknown"),
  ]
    .filter(Boolean)
    .join("\n");
  const details = `${title}\n${description}`;
  toast.error(title, {
    description,
    classNames: {
      description: "toast-error-details",
    },
    duration: 30000,
    closeButton: true,
    action: {
      label: t("file_import_error.copy_details"),
      onClick: (event) => {
        // Keep the diagnostic visible after copying it.
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
