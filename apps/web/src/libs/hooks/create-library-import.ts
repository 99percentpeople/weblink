import { createSignal, onCleanup } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { cacheManager } from "@/libs/application/cache-service";
import { handleDropItems } from "@/libs/utils/process-file";
import { showFileImportProgress } from "@/components/files/file-import-progress";
import {
  showFileImportError,
  type FileImportStage,
} from "@/components/files/file-import-error";

export type LibraryImport = ReturnType<
  typeof createLibraryImport
>;

class ImportPreparationError extends Error {
  constructor(
    readonly stage: "preparing" | "authorizing",
    cause: unknown,
  ) {
    super("File import preparation failed", { cause });
  }
}

/** Keep picker and drop imports in the same cancellable operation. */
export function createLibraryImport(
  options: {
    shared?: boolean;
    /** Keep an active cache import running after its dialog closes. */
    background?: boolean;
  } = {},
) {
  const [importing, setImporting] = createSignal(false);
  let current: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    if (!options.background) current?.abort();
  });

  const openPicker = async (
    input: HTMLInputElement,
  ): Promise<void> => {
    if (disposed || importing()) return;
    setImporting(true);
    try {
      await cacheManager.storage.authorizeDefault();
      if (!disposed) input.click();
    } catch (error) {
      if (!disposed)
        showFileImportError(error, {
          stage: "authorizing",
        });
    } finally {
      if (!disposed) setImporting(false);
    }
  };

  const importFiles = async (
    read: (signal: AbortSignal) => File[] | Promise<File[]>,
  ): Promise<void> => {
    if (disposed || importing()) return;
    const controller = new AbortController();
    const { signal } = controller;
    current = controller;
    setImporting(true);
    const notice = showFileImportProgress(controller);
    const dismiss = notice.dismiss;
    signal.addEventListener("abort", dismiss, {
      once: true,
    });
    let stage: FileImportStage = "preparing";
    let currentFile: File | undefined;
    let total: number | undefined;
    let completed = 0;
    try {
      // Start reading synchronously while a drop's data store is accessible.
      const reading = Promise.resolve(read(signal)).catch(
        (cause) => {
          throw new ImportPreparationError(
            "preparing",
            cause,
          );
        },
      );
      const [files] = await Promise.all([
        reading,
        cacheManager.storage
          .authorizeDefault()
          .catch((cause) => {
            throw new ImportPreparationError(
              "authorizing",
              cause,
            );
          }),
      ]);
      signal.throwIfAborted();
      total = files.length;
      notice.setFiles(files);
      let reused = false;
      for (const file of files) {
        signal.throwIfAborted();
        currentFile = file;
        stage = "identifying";
        notice.startFile(file);
        const result =
          await cacheManager.library.importFile(file, {
            signal,
            silent: true,
            onImportProgress: (progress) => {
              stage = progress.phase;
              notice.update(progress);
            },
          });
        signal.throwIfAborted();
        reused ||= result.reused;
        completed++;
        if (options.shared) {
          stage = "sharing";
          await cacheManager.library.setShared(
            result.cache.id,
            true,
          );
        }
        signal.throwIfAborted();
        notice.completeFile();
      }
      signal.throwIfAborted();
      if (files.length)
        toast.success(
          t(
            options.shared
              ? "shared_files.added"
              : reused
                ? "file_library.reused"
                : "file_library.imported",
          ),
        );
    } catch (error) {
      if (!signal.aborted)
        showFileImportError(
          error instanceof ImportPreparationError
            ? error.cause
            : error,
          {
            stage:
              error instanceof ImportPreparationError
                ? error.stage
                : stage,
            file: currentFile,
            completed,
            total,
          },
        );
      controller.abort();
    } finally {
      signal.removeEventListener("abort", dismiss);
      dismiss();
      current = undefined;
      if (!disposed) setImporting(false);
    }
  };

  const onDrop = (event: DragEvent): void => {
    const transfer = event.dataTransfer;
    if (!transfer) return;
    void importFiles((signal) =>
      transfer.items?.length
        ? handleDropItems(transfer.items, signal)
        : Array.from(transfer.files ?? []),
    );
  };

  return { importing, importFiles, openPicker, onDrop };
}
