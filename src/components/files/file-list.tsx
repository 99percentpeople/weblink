import {
  createEffect,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  File,
  LoaderCircle,
  MoreHorizontal,
  Check,
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
import { t } from "@/i18n";
import { Dynamic } from "solid-js/web";

function FileThumbnail(props: { file: LibraryFile }) {
  const [url, setUrl] = createSignal<string>();
  createEffect(() => {
    const file = props.file.file;
    if (!file || fileKind(props.file) !== "image") {
      setUrl(undefined);
      return;
    }
    const value = URL.createObjectURL(file);
    setUrl(value);
    onCleanup(() => URL.revokeObjectURL(value));
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
  | "preview"
  | "download"
  | "send"
  | "details"
  | "delete";
export function FileList(props: {
  files: LibraryFile[];
  selected: readonly string[];
  picker?: boolean;
  onToggle(id: string): void;
  onAction?(action: FileAction, file: LibraryFile): void;
}) {
  return (
    <div class="divide-border divide-y" role="list">
      <For each={props.files}>
        {(file) => {
          const available = () =>
            !!file.isComplete && !!file.file;
          return (
            <div
              class="hover:bg-muted/50 flex items-center gap-3 rounded-md px-2
                py-3"
              role="listitem"
            >
              <Checkbox
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
              <span
                class="text-muted-foreground flex shrink-0 items-center gap-1
                  text-xs"
              >
                <Show
                  when={available()}
                  fallback={
                    <Show
                      when={file.isMerging}
                      fallback={
                        <span>
                          {t(
                            "file_library.status_incomplete",
                          )}
                        </span>
                      }
                    >
                      <LoaderCircle class="size-4 animate-spin" />
                    </Show>
                  }
                >
                  <Check class="size-3.5" />
                  <span class="hidden sm:inline">
                    {t("file_library.status_complete")}
                  </span>
                </Show>
              </span>
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
                    <For
                      each={
                        [
                          "preview",
                          "download",
                          "send",
                          "details",
                          "delete",
                        ] as FileAction[]
                      }
                    >
                      {(action) => (
                        <DropdownMenuItem
                          disabled={
                            !["details", "delete"].includes(
                              action,
                            ) && !available()
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
                          {t(
                            `file_library.action_${action}`,
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
