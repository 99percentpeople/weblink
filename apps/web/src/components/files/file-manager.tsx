import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  For,
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
import {
  downloadFile,
  saveFile,
  saveFileAs,
} from "@/libs/utils/download-file";
import { handleSelectFolder } from "@/libs/utils/process-file";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import DropArea from "@/components/drop-area";
import { FileDropOverlay } from "@/components/file-drop-overlay";
import { createLibraryImport } from "@/libs/hooks/create-library-import";
import { MountedDirectoryMenu } from "./mounted-directory-menu";
import { platform } from "@/libs/platform/runtime";
import { useNotifications } from "@/libs/state/notifications-context";
import { saveFilesWithFeedback } from "./save-files-with-feedback";

export default function FileManager() {
  const [mountId, setMountId] = createSignal(
    cacheManager.storage.defaultMountId,
  );
  onMount(() => {
    const refresh = () =>
      setMountId(cacheManager.storage.defaultMountId);
    onCleanup(cacheManager.storage.onChange(refresh));
    refresh();
  });
  const files = useLibraryFiles(mountId);
  const [selection, setSelection] = createSignal<string[]>(
    [],
  );
  const selected = createMemo(() =>
    files().filter((file) => selection().includes(file.id)),
  );
  const [saving, setSaving] = createSignal(false);
  const notifications = useNotifications();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const selectedDownloads = createMemo(() =>
    selected().filter(
      (file) => file.storageKind === "indexeddb",
    ),
  );
  const selectedSaveAs = createMemo(() =>
    selected().filter(
      (file) =>
        file.storageKind === "directory" ||
        file.storageKind === "native",
    ),
  );
  const saveSelectionLabel = () =>
    selectedSaveAs().length
      ? t("file_library.action_save_as")
      : selectedDownloads().length
        ? t("file_library.action_download")
        : "";
  const [storage, setStorage] =
    createSignal<StorageEstimate>();
  const { importing, importFiles, openPicker, onDrop } =
    createLibraryImport({ background: true });
  const [detail, setDetail] = createSignal<LibraryFile>();
  const [deleting, setDeleting] = createSignal<
    LibraryFile[]
  >([]);
  const preview = createPreviewDialog();
  const forward = createForwardDialog();
  let fileInput!: HTMLInputElement;
  let folderInput!: HTMLInputElement;
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
      <dl class="space-y-3 break-all text-sm">
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
            detail()?.storageUnavailable
              ? "storage.unavailable"
              : detail()?.isComplete
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
  const saveSelection = async () => {
    if (saving()) return;
    const downloads = selectedDownloads();
    const saveAs = selectedSaveAs();
    if (
      downloads.length + saveAs.length !==
        selected().length ||
      selected().some(
        (file) => !file.isComplete || !file.file,
      )
    )
      return;
    setSaving(true);
    try {
      // Invoke browser pickers before any cache reads or downloads.
      if (saveAs.length) {
        const files = selected().map((file) => file.file!);
        await saveFilesWithFeedback(files, notifications);
        return;
      }
      for (const file of downloads)
        if (
          !(await saveFile(file.file!, file.file!.name, {
            automatic: true,
          }))
        )
          return;
    } finally {
      if (!disposed) setSaving(false);
    }
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
    if (action === "reveal") {
      const location = await cacheManager
        .getCache(file.id)
        ?.storageLocation?.();
      if (
        location?.kind !== "native" ||
        !platform.filesystem?.revealFile
      )
        throw new Error("File location is unavailable");
      await platform.filesystem.revealFile(
        location.mountId,
        location.path,
      );
      return;
    }
    if (action === "save_as") {
      if (!file.file || !file.isComplete)
        throw new Error("File is incomplete");
      await saveFileAs(file.file);
      return;
    }
    const cache = cacheManager.getCache(file.id);
    const current = await cache?.getInfo();
    if (!current?.file || !current.isComplete)
      throw new Error("File is incomplete");
    if (action === "preview")
      await preview.open(current.file);
    else if (action === "download")
      downloadFile(current.file, { automatic: true });
    else await forward.forwardCache(current);
  };
  return (
    <DropArea
      class="relative flex min-h-0 min-w-0 flex-1 flex-col gap-4"
      disabled={importing()}
      onDrop={onDrop}
      overlay={(state) => (
        <FileDropOverlay
          state={state}
          title={t("file_library.drop_files")}
          unavailableTitle={t("common.file_drop.busy")}
        />
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
          aria-label={t("shared_files.upload_files")}
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
          aria-label={t("shared_files.upload_folder")}
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
        <div class="flex flex-wrap items-center gap-2">
          <Show when={platform.filesystem}>
            <MountedDirectoryMenu
              storage={cacheManager.storage}
            />
          </Show>
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
                onSelect={() => void openPicker(fileInput)}
              >
                {t("shared_files.upload_files")}
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() =>
                  void openPicker(folderInput)
                }
              >
                {t("shared_files.upload_folder")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      <FileBrowser
        mountId={mountId()}
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
          <Show when={saveSelectionLabel()}>
            <Button
              size="sm"
              variant="outline"
              disabled={
                saving() ||
                selectedDownloads().length +
                  selectedSaveAs().length !==
                  selected().length ||
                selected().some(
                  (file) => !file.isComplete || !file.file,
                )
              }
              onClick={() =>
                void saveSelection().catch(report)
              }
            >
              {saveSelectionLabel()}
            </Button>
          </Show>
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
