import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  File,
  LoaderCircle,
  MoreHorizontal,
  Image,
  Video,
  Music,
  FileText,
} from "lucide-solid";
import {
  Checkbox,
  CheckboxControl,
} from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fileKind,
  type LibraryFile,
} from "@/libs/application/files/library-query";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { fileOpenLabel } from "@/libs/utils/open-file";
import { t } from "@/i18n";
import { Dynamic } from "solid-js/web";
import type { FileMetaData } from "@/libs/domain/file";

export function FileThumbnail(props: {
  file: FileMetaData;
}) {
  const [url, setUrl] = createSignal<string>();
  const source = createMemo(() =>
    fileKind(props.file) === "image"
      ? props.file.file
      : undefined,
  );
  createEffect(() => {
    const file = source();
    if (!file) {
      setUrl(undefined);
      return;
    }
    const value = fileObjectUrl(file);
    setUrl(value);
    onCleanup(() => revokeFileUrl(value));
  });
  const icon = () =>
    ({
      image: Image,
      video: Video,
      audio: Music,
      document: FileText,
      other: File,
    })[fileKind(props.file)];
  return (
    <div
      class="bg-muted text-muted-foreground flex size-10 shrink-0
        items-center justify-center overflow-hidden rounded-md"
    >
      <Show
        when={url()}
        fallback={
          <Dynamic component={icon()} class="size-5" />
        }
      >
        <img
          src={url()}
          alt=""
          class="size-full object-cover"
          loading="lazy"
        />
      </Show>
    </div>
  );
}

export type FileAction =
  | "share"
  | "unshare"
  | "preview"
  | "download"
  | "save_as"
  | "reveal"
  | "send"
  | "details"
  | "delete";
export function FileList(props: {
  files: LibraryFile[];
  selected: readonly string[];
  picker?: boolean;
  showSharedStatus?: boolean;
  actions?: FileAction[];
  onToggle(id: string): void;
  onAction?(action: FileAction, file: LibraryFile): void;
}) {
  const [rows, setRows] = createStore<LibraryFile[]>([]);
  // Directory scans and transfer progress rebuild projections. Preserve each row
  // by ID so unrelated updates do not remount media and recreate their URLs.
  createEffect(() =>
    setRows(reconcile(props.files, { key: "id" })),
  );
  return (
    <div class="divide-border divide-y" role="list">
      <For each={rows}>
        {(file) => {
          const available = () =>
            !!file.isComplete && !!file.file;
          const actions = createMemo<FileAction[]>(() =>
            (
              props.actions ??
              ([
                file.isShared ? "unshare" : "share",
                "preview",
                "reveal",
                "download",
                "send",
                "details",
                "delete",
              ] as FileAction[])
            ).flatMap((action): FileAction[] => {
              if (action === "reveal")
                return file.capabilities?.reveal
                  ? [action]
                  : [];
              if (
                action === "download" ||
                action === "save_as"
              )
                return file.capabilities?.save ===
                  "download"
                  ? ["download"]
                  : file.capabilities?.save === "save-as"
                    ? ["save_as"]
                    : [];
              return [action];
            }),
          );
          return (
            <div
              class="hover:bg-muted/50 flex items-center gap-3 rounded-md px-2
                py-3"
              role="listitem"
            >
              <Checkbox
                class="relative shrink-0"
                checked={props.selected.includes(file.id)}
                disabled={props.picker && !available()}
                onChange={() => props.onToggle(file.id)}
                aria-label={file.fileName}
              >
                <CheckboxControl />
              </Checkbox>
              <FileThumbnail file={file} />
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                disabled={props.picker && !available()}
                onClick={() =>
                  props.picker
                    ? props.onToggle(file.id)
                    : props.onAction?.(
                        available() ? "preview" : "details",
                        file,
                      )
                }
              >
                <span
                  class="block truncate text-sm font-medium"
                  title={file.fileName}
                >
                  {file.fileName}
                </span>
                <span class="text-muted-foreground mt-1 flex gap-2 text-xs">
                  <span>
                    {formatBtyeSize(file.fileSize)}
                  </span>
                  <Show
                    when={
                      file.isShared &&
                      props.showSharedStatus !== false
                    }
                  >
                    <span>{t("shared_files.shared")}</span>
                  </Show>
                  <span>·</span>
                  <span class="truncate">
                    {file.createdAt
                      ? new Date(
                          file.createdAt,
                        ).toLocaleDateString()
                      : t("file_library.local_file")}
                  </span>
                </span>
              </button>
              <Show when={!available()}>
                <span
                  class="text-muted-foreground flex shrink-0 items-center gap-1
                    text-xs"
                >
                  <Show when={file.isMerging}>
                    <LoaderCircle class="size-4 animate-spin" />
                  </Show>
                  <span>
                    {t("file_library.status_incomplete")}
                  </span>
                </span>
              </Show>
              <Show when={!props.picker}>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={Button}
                    size="icon"
                    variant="ghost"
                    class="size-8"
                    aria-label={t("file_library.actions")}
                  >
                    <MoreHorizontal class="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent>
                    <For each={actions()}>
                      {(action) => (
                        <DropdownMenuItem
                          disabled={
                            action === "reveal"
                              ? !!file.storageUnavailable ||
                                !!file.storageMissing
                              : ![
                                  "details",
                                  "delete",
                                  "unshare",
                                ].includes(action) &&
                                !available()
                          }
                          class={
                            action === "delete"
                              ? "text-destructive"
                              : ""
                          }
                          onSelect={() =>
                            props.onAction?.(action, file)
                          }
                        >
                          {action === "preview"
                            ? fileOpenLabel()
                            : t(
                                action === "share" ||
                                  action === "unshare"
                                  ? `shared_files.${action}`
                                  : `file_library.action_${action}`,
                              )}
                        </DropdownMenuItem>
                      )}
                    </For>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Show>
            </div>
          );
        }}
      </For>
    </div>
  );
}
