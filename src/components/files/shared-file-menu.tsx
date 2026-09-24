import { userErrorMessage } from "@/libs/user-error";
import { createSignal, onCleanup, Show } from "solid-js";
import {
  ChevronDown,
  FolderUp,
  Library,
  Upload,
} from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cacheManager } from "@/libs/application/cache-service";
import { handleSelectFolder } from "@/libs/utils/process-file";
import { t } from "@/i18n";
import FilePickerDialog from "./file-picker-dialog";

const report = (error: unknown) =>
  toast.error(
    userErrorMessage(error, "errors.file_failed"),
  );

/** Explicit additions to the shared list, independent of chat sends. */
export function SharedFileMenu() {
  const [picking, setPicking] = createSignal(false);
  const [importing, setImporting] = createSignal(false);
  let fileInput!: HTMLInputElement;
  let folderInput!: HTMLInputElement;
  let trigger!: HTMLButtonElement;
  let currentImport: AbortController | undefined;
  onCleanup(() => currentImport?.abort());

  const importFiles = async (
    read: (signal: AbortSignal) => Promise<File[]>,
  ) => {
    if (importing()) return;
    const controller = new AbortController();
    currentImport = controller;
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
    try {
      const files = await read(controller.signal);
      for (const file of files) {
        controller.signal.throwIfAborted();
        const { cache } =
          await cacheManager.library.importFile(file, {
            signal: controller.signal,
          });
        controller.signal.throwIfAborted();
        await cacheManager.library.setShared(
          cache.id,
          true,
        );
      }
      if (files.length)
        toast.success(t("shared_files.added"));
    } catch (error) {
      if (!controller.signal.aborted) report(error);
    } finally {
      toast.dismiss(toastId);
      currentImport = undefined;
      setImporting(false);
    }
  };

  return (
    <div class="flex shrink-0 items-center">
      <input
        ref={fileInput}
        class="hidden"
        type="file"
        multiple
        aria-label={t("shared_files.upload_files")}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = Array.from(input.files ?? []);
          input.value = "";
          if (files.length)
            void importFiles(async () => files);
        }}
      />
      <input
        ref={folderInput}
        class="hidden"
        type="file"
        // @ts-expect-error Browser directory picker attribute.
        webkitdirectory=""
        aria-label={t("shared_files.upload_folder")}
        onChange={(event) => {
          const input = event.currentTarget;
          const files = input.files;
          if (!files?.length) return;
          void importFiles(async (signal) => [
            await handleSelectFolder(files, signal),
          ]).finally(() => (input.value = ""));
        }}
      />
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          as={Button}
          ref={trigger}
          variant="ghost"
          size="sm"
          class="gap-1.5"
          disabled={importing()}
        >
          {t("shared_files.add")}
          <ChevronDown class="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          onCloseAutoFocus={(event) => {
            if (picking()) event.preventDefault();
          }}
        >
          <DropdownMenuItem
            onSelect={() => setPicking(true)}
          >
            <Library />
            {t("shared_files.from_library")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => fileInput.click()}
          >
            <Upload />
            {t("shared_files.upload_files")}
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => folderInput.click()}
          >
            <FolderUp />
            {t("shared_files.upload_folder")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Show when={picking()}>
        <FilePickerDialog
          sharing
          open
          onClose={() => setPicking(false)}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.isConnected) trigger.focus();
          }}
          onSelect={(ids) => {
            setPicking(false);
            void cacheManager.library
              .setSharedBatch(ids, true)
              .catch(report);
          }}
        />
      </Show>
    </div>
  );
}
