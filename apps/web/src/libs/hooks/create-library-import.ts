import { createSignal, onCleanup } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { cacheManager } from "@/libs/application/cache-service";
import { userErrorMessage } from "@/libs/user-error";
import { handleDropItems } from "@/libs/utils/process-file";

export type LibraryImport = ReturnType<
  typeof createLibraryImport
>;

/** Keep picker and drop imports in the same cancellable operation. */
export function createLibraryImport(
  options: { shared?: boolean } = {},
) {
  const [importing, setImporting] = createSignal(false);
  let current: AbortController | undefined;
  let disposed = false;
  onCleanup(() => {
    disposed = true;
    current?.abort();
  });

  const importFiles = async (
    read: (signal: AbortSignal) => File[] | Promise<File[]>,
  ): Promise<void> => {
    if (disposed || importing()) return;
    const controller = new AbortController();
    const { signal } = controller;
    current = controller;
    setImporting(true);
    const toastId = toast.loading(
      t("common.notification.processing_files"),
      {
        duration: Infinity,
        action: {
          label: t("common.action.cancel"),
          onClick: () => controller.abort(),
        },
      },
    );
    const dismiss = () => toast.dismiss(toastId);
    signal.addEventListener("abort", dismiss, {
      once: true,
    });
    try {
      // Start reading synchronously while a drop's data store is accessible.
      const files = await read(signal);
      signal.throwIfAborted();
      let reused = false;
      for (const file of files) {
        signal.throwIfAborted();
        const result =
          await cacheManager.library.importFile(file, {
            signal,
          });
        signal.throwIfAborted();
        reused ||= result.reused;
        if (options.shared)
          await cacheManager.library.setShared(
            result.cache.id,
            true,
          );
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
        toast.error(
          userErrorMessage(error, "errors.file_failed"),
        );
    } finally {
      signal.removeEventListener("abort", dismiss);
      dismiss();
      current = undefined;
      setImporting(false);
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

  return { importing, importFiles, onDrop };
}
