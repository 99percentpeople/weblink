import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createMemo,
  createSignal,
  Show,
  type JSX,
} from "solid-js";
import { FolderOpen, LoaderCircle } from "lucide-solid";
import { appState } from "@/libs/state/app-state";
import {
  libraryFiles,
  queryLibrary,
  type FileKind,
  type LibraryFile,
} from "@/libs/application/files/library-query";
import { FileFilters } from "./file-filters";
import { FileList, type FileAction } from "./file-list";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { cacheManager } from "@/libs/application/cache-service";

export function useLibraryFiles() {
  return createMemo(() =>
    libraryFiles(Object.values(appState.cache.cacheInfo)),
  );
}
export function FileBrowser(props: {
  selected: readonly string[];
  onSelection(ids: string[]): void;
  picker?: boolean;
  sharing?: "shared" | "private";
  actions?: FileAction[];
  onAction?(action: FileAction, file: LibraryFile): void;
  footer?: JSX.Element;
}) {
  const files = useLibraryFiles();
  const [search, setSearch] = createSignal("");
  const [kind, setKind] = createSignal<FileKind>("all");
  const [status, setStatus] = createSignal<
    "all" | "complete" | "incomplete"
  >("all");
  const [sharing, setSharing] = createSignal<
    "all" | "shared" | "private"
  >("all");
  const [sort, setSort] = createSignal<
    "recent" | "name" | "size"
  >("recent");
  const eligible = createMemo(() =>
    files().filter(
      (file) =>
        (!props.picker || (file.isComplete && file.file)) &&
        (!props.sharing ||
          !!file.isShared === (props.sharing === "shared")),
    ),
  );
  const visible = createMemo(() =>
    queryLibrary(eligible(), {
      sharing: props.sharing ?? sharing(),
      search: search(),
      kind: kind(),
      status: props.picker ? "complete" : status(),
      sort: sort(),
    }),
  );
  createEffect(() => {
    const valid = new Set(
      eligible().map((file) => file.id),
    );
    const next = props.selected.filter((id) =>
      valid.has(id),
    );
    if (next.length !== props.selected.length)
      props.onSelection(next);
  });
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
      <FileFilters
        sharing={props.sharing ? undefined : sharing()}
        onSharing={setSharing}
        search={search()}
        onSearch={setSearch}
        kind={kind()}
        onKind={setKind}
        status={props.picker ? undefined : status()}
        onStatus={setStatus}
        sort={sort()}
        onSort={setSort}
      />
      <div
        class="scrollbar-thin min-h-0 flex-1 overflow-y-auto
          overscroll-contain"
      >
        <Show when={appState.cache.error}>
          <div
            role="alert"
            class="flex flex-col items-center gap-3 p-8 text-sm"
          >
            <p>
              {userErrorMessage(
                appState.cache.error,
                "errors.storage_unavailable",
              )}
            </p>
            <Button
              variant="outline"
              onClick={() => void cacheManager.initialize()}
            >
              {t("common.action.retry")}
            </Button>
          </div>
        </Show>
        <Show
          when={
            !appState.cache.error &&
            appState.cache.status === "ready"
          }
          fallback={
            <Show when={!appState.cache.error}>
              <div class="flex justify-center p-12">
                <LoaderCircle class="text-muted-foreground size-6 animate-spin" />
              </div>
            </Show>
          }
        >
          <Show
            when={visible().length}
            fallback={
              <div
                class="text-muted-foreground flex flex-col items-center gap-3 py-16
                  text-sm"
              >
                <FolderOpen class="size-10 opacity-50" />
                <p>
                  {t(
                    files().length
                      ? "file_library.no_results"
                      : "file_library.empty",
                  )}
                </p>
              </div>
            }
          >
            <FileList
              files={visible()}
              picker={props.picker}
              showSharedStatus={!props.sharing}
              showAvailableStatus={
                props.sharing !== "shared"
              }
              actions={props.actions}
              selected={props.selected}
              onToggle={(id) =>
                props.onSelection(
                  props.selected.includes(id)
                    ? props.selected.filter(
                        (value) => value !== id,
                      )
                    : [...props.selected, id],
                )
              }
              onAction={props.onAction}
            />
          </Show>
        </Show>
      </div>
      {props.footer}
    </div>
  );
}
