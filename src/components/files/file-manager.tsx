import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { ChevronDown, Upload } from "lucide-solid";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  FileBrowser,
  useLibraryFiles,
} from "./file-browser";
import type { FileAction } from "./file-list";
import type { LibraryFile } from "@/libs/application/files/library-query";
import { cacheManager } from "@/libs/application/cache-service";
import { appState } from "@/libs/state/app-state";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { createForwardDialog } from "@/components/dialogs/forward-dialog";
import { createDialog } from "@/components/dialogs/dialog";
import { downloadFile } from "@/libs/utils/download-file";
import {
  handleDropItems,
  handleSelectFolder,
} from "@/libs/utils/process-file";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import DropArea from "@/components/drop-area";

export default function FileManager() {
  const files = useLibraryFiles();
  const [selection, setSelection] = createSignal<string[]>(
    [],
  );
  const selected = createMemo(() =>
    files().filter((file) => selection().includes(file.id)),
  );
  const [storage, setStorage] =
    createSignal<StorageEstimate>();
  const [importing, setImporting] = createSignal(false);
  const [detail, setDetail] = createSignal<LibraryFile>();
  const [deleting, setDeleting] = createSignal<
    LibraryFile[]
  >([]);
  const preview = createPreviewDialog();
  const forward = createForwardDialog();
  let fileInput!: HTMLInputElement;
  let folderInput!: HTMLInputElement;
  const controllers = new Set<AbortController>();
  onCleanup(() =>
    controllers.forEach((controller) => controller.abort()),
  );
  createEffect(() => {
    files();
    void navigator.storage
      ?.estimate()
      .then(setStorage)
      .catch(() => {});
  });
  const relatedMessages = createMemo(() =>
    appState.message.messages.filter(
      (message) =>
        message.type === "file" &&
        message.fid &&
        detail()?.referenceIds.includes(message.fid),
    ),
  );
  const details = createDialog<void>({
    title: () => detail()?.fileName,
    content: () => (
      <dl class="space-y-3 text-sm break-all">
        <dt class="text-muted-foreground">
          {t("file_library.aliases")}
        </dt>
        <dd>
          <For each={detail()?.aliases}>
            {(name) => <p>{name}</p>}
          </For>
        </dd>
        <dt class="text-muted-foreground">
          {t("file_library.references")}
        </dt>
        <dd>{detail()?.referenceIds.length}</dd>
        <dt class="text-muted-foreground">
          {t("file_library.status")}
        </dt>
        <dd>
          {t(
            detail()?.isComplete
              ? "file_library.status_complete"
              : "file_library.status_incomplete",
          )}
        </dd>
        <dt class="text-muted-foreground">
          {t("file_library.related_messages")}
        </dt>
        <dd class="space-y-2">
          <For
            each={relatedMessages()}
            fallback={<p>{t("file_library.local_file")}</p>}
          >
            {(message) => (
              <div>
                <p>
                  {appState.message.conversations.find(
                    (item) =>
                      item.id === message.conversationId,
                  )?.title ||
                    appState.message.clients.find(
                      (item) =>
                        item.clientId ===
                        (message.client ===
                        appState.profile.clientId
                          ? message.target
                          : message.client),
                    )?.name ||
                    message.client}
                </p>
                <p class="text-muted-foreground text-xs">
                  {new Date(
                    message.createdAt,
                  ).toLocaleString()}{" "}
                  ·{" "}
                  {message.type === "file"
                    ? message.fileName
                    : ""}
                </p>
              </div>
            )}
          </For>
        </dd>
        <dt class="text-muted-foreground">
          {t("file_library.fingerprint")}
        </dt>
        <dd class="font-mono text-xs">
          {detail()?.fingerprint?.digest ??
            t("file_library.legacy")}
        </dd>
      </dl>
    ),
  });
  const confirmation = createDialog<boolean>({
    title: () => t("file_library.action_delete"),
    description: () =>
      t("file_library.delete_description", {
        count: deleting().reduce(
          (sum, file) => sum + file.referenceIds.length,
          0,
        ),
      }),
    content: () => (
      <ul class="space-y-1 text-sm">
        <For each={deleting()}>
          {(file) => (
            <li class="truncate">{file.fileName}</li>
          )}
        </For>
      </ul>
    ),
    cancel: (
      <Button
        variant="outline"
        onClick={() => confirmation.close()}
      >
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => confirmation.submit(true)}
      >
        {t("common.action.delete")}
      </Button>
    ),
  });
  const report = (error: unknown) =>
    toast.error(
      userErrorMessage(error, "errors.file_failed"),
    );
  const remove = async (items: LibraryFile[]) => {
    setDeleting(items);
    if (!(await confirmation.open()).result) return;
    for (const file of items)
      await cacheManager.remove(file.id);
    setSelection([]);
  };
  const act = async (
    action: FileAction,
    file: LibraryFile,
  ) => {
    if (action === "delete") return remove([file]);
    if (action === "share" || action === "unshare")
      return cacheManager.library.setShared(
        file.id,
        action === "share",
      );
    if (action === "details") {
      setDetail(file);
      await details.open();
      return;
    }
    const cache = cacheManager.getCache(file.id);
    const current = await cache?.getInfo();
    if (!current?.file || !current.isComplete)
      throw new Error("File is incomplete");
    if (action === "preview")
      await preview.open(current.file);
    else if (action === "download")
      downloadFile(current.file);
    else await forward.forwardCache(current);
  };
  const importFiles = async (
    read: (signal: AbortSignal) => Promise<File[]>,
  ) => {
    if (importing()) return;
    const controller = new AbortController();
    controllers.add(controller);
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
      const incoming = await read(controller.signal);
      let reused = false;
      for (const file of incoming) {
        controller.signal.throwIfAborted();
        const result =
          await cacheManager.library.importFile(file, {
            signal: controller.signal,
          });
        reused ||= result.reused;
      }
      if (incoming.length)
        toast.success(
          t(
            reused
              ? "file_library.reused"
              : "file_library.imported",
          ),
        );
    } catch (error) {
      if (!controller.signal.aborted) report(error);
    } finally {
      toast.dismiss(toastId);
      controllers.delete(controller);
      setImporting(false);
    }
  };
  return (
    <DropArea
      class="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4"
      onDrop={(event) => {
        if (event.dataTransfer?.items)
          void importFiles((signal) =>
            handleDropItems(
              event.dataTransfer!.items,
              signal,
            ),
          );
      }}
      overlay={(event) => (
        <Show
          when={event?.dataTransfer?.types.includes(
            "Files",
          )}
        >
          <div
            class="bg-background/90 pointer-events-none absolute inset-0 z-20
              flex items-center justify-center rounded-lg border-2
              border-dashed"
          >
            {t("file_library.import")}
          </div>
        </Show>
      )}
    >
      <div class="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <span class="text-muted-foreground text-xs">
          <Show when={storage()}>
            {(value) =>
              t("cache.usage", {
                value: formatBtyeSize(value().usage ?? 0),
                max: formatBtyeSize(value().quota ?? 0),
                remaining: formatBtyeSize(
                  (value().quota ?? 0) -
                    (value().usage ?? 0),
                ),
              })
            }
          </Show>
        </span>
        <input
          ref={fileInput}
          class="hidden"
          type="file"
          multiple
          onChange={(event) => {
            const input = event.currentTarget;
            const files = Array.from(input.files ?? []);
            input.value = "";
            void importFiles(async () => files);
          }}
        />
        <input
          ref={folderInput}
          class="hidden"
          type="file"
          // @ts-expect-error Browser directory picker attribute.
          webkitdirectory=""
          onChange={(event) => {
            const input = event.currentTarget;
            const files = input.files;
            void importFiles(async (signal) =>
              files
                ? [await handleSelectFolder(files, signal)]
                : [],
            ).finally(() => (input.value = ""));
          }}
        />
        <DropdownMenu>
          <DropdownMenuTrigger
            as={Button}
            variant="outline"
            size="sm"
            disabled={importing()}
          >
            <Upload class="mr-2 size-4" />
            {t("file_library.import")}
            <ChevronDown class="ml-2 size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuItem
              onSelect={() => fileInput.click()}
            >
              {t("shared_files.upload_files")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => folderInput.click()}
            >
              {t("shared_files.upload_folder")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <FileBrowser
        selected={selection()}
        onSelection={setSelection}
        onAction={(action, file) =>
          void act(action, file).catch(report)
        }
      />
      <Show when={selected().length}>
        <div
          class="border-border flex shrink-0 flex-wrap items-center gap-2
            border-t pt-3"
        >
          <span class="text-muted-foreground mr-auto text-xs">
            {t("file_library.selection", {
              count: selected().length,
              size: formatBtyeSize(
                selected().reduce(
                  (sum, file) => sum + file.fileSize,
                  0,
                ),
              ),
            })}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={selected().some(
              (file) => !file.isComplete || !file.file,
            )}
            onClick={() => forward.forwardCache(selected())}
          >
            {t("common.action.send")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={selected().some(
              (file) => !file.isComplete || !file.file,
            )}
            onClick={() =>
              selected().forEach(
                (file) =>
                  void act("download", file).catch(report),
              )
            }
          >
            {t("common.action.download")}
          </Button>
          <For each={[true, false]}>
            {(enabled) => (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  enabled &&
                  selected().some(
                    (file) => !file.isComplete,
                  )
                }
                onClick={() =>
                  void cacheManager.library
                    .setSharedBatch(
                      selected().map((file) => file.id),
                      enabled,
                    )
                    .catch(report)
                }
              >
                {t(
                  enabled
                    ? "shared_files.share"
                    : "shared_files.unshare",
                )}
              </Button>
            )}
          </For>
          <Button
            size="sm"
            variant="destructive"
            onClick={() =>
              void remove(selected()).catch(report)
            }
          >
            {t("common.action.delete")}
          </Button>
        </div>
      </Show>
    </DropArea>
  );
}
