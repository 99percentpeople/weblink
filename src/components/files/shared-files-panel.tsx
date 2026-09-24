import { userErrorMessage } from "@/libs/user-error";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  Show,
} from "solid-js";
import {
  ChevronLeft,
  FolderOpen,
  LoaderCircle,
  RefreshCw,
  Search,
} from "lucide-solid";
import { toast } from "solid-sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SidebarBrowser } from "@/components/common/sidebar-browser";
import {
  Checkbox,
  CheckboxControl,
  CheckboxLabel,
} from "@/components/ui/checkbox";
import { ClientAvatar } from "@/components/common/client-avatar";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { cacheManager } from "@/libs/application/cache-service";
import { createRemoteCatalog } from "@/libs/hooks/file-catalog";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";
import { FileBrowser } from "./file-browser";
import { SharedFileMenu } from "./shared-file-menu";
import { SharedFileRow } from "./shared-file-row";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import { isActiveTask } from "@/libs/application/task-service";
import type { FileMetaData } from "@/libs/domain/file";
import type {
  ProtocolFileMetadata,
  StorageSortField,
} from "@/libs/domain/protocol";

const report = (error: unknown) =>
  toast.error(
    userErrorMessage(error, "errors.file_failed"),
  );

function MySharedFiles() {
  const [selected, setSelected] = createSignal<string[]>(
    [],
  );
  const preview = createPreviewDialog();
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 p-3">
      <FileBrowser
        sharing="shared"
        selected={selected()}
        onSelection={setSelected}
        actions={["unshare"]}
        onAction={(action, file) => {
          if (action === "unshare")
            void cacheManager.library
              .setShared(file.id, false)
              .catch(report);
          else if (file.file) void preview.open(file.file);
        }}
      />
      <Show when={selected().length}>
        <Button
          variant="outline"
          onClick={() =>
            void cacheManager.library
              .setSharedBatch(selected(), false)
              .then(() => setSelected([]))
              .catch(report)
          }
        >
          {t("shared_files.unshare")}
        </Button>
      </Show>
    </div>
  );
}

function RemoteSharedFiles(props: {
  peerId: string;
  active: boolean;
}) {
  const app = useAppState();
  const preview = createPreviewDialog();
  const [search, setSearch] = createSignal("");
  const [query, setQuery] = createSignal("");
  const [sort, setSort] =
    createSignal<StorageSortField>("fileName");
  const [desc, setDesc] = createSignal(false);
  const [pageIndex, setPageIndex] = createSignal(0);
  const [pageSize, setPageSize] = createSignal(50);
  const [selected, setSelected] = createSignal<string[]>(
    [],
  );
  const session = () =>
    appState.session.sessions[props.peerId];
  const connected = () =>
    !!session() &&
    appState.session.clientViewData[props.peerId]
      ?.onlineStatus === "online" &&
    !!appState.session.clientViewData[props.peerId]
      ?.messageChannel;
  const supported = () =>
    !!session() && app.supportsSharedFiles(session()!);
  createEffect(() => {
    const value = search();
    const timer = setTimeout(() => {
      setQuery(value);
      setPageIndex(0);
    }, 250);
    onCleanup(() => clearTimeout(timer));
  });
  const remote = createRemoteCatalog(
    app.catalog,
    () =>
      props.active && connected() && supported()
        ? session()
        : undefined,
    () => ({
      pageIndex: pageIndex(),
      pageSize: pageSize(),
      search: query(),
      sort: [{ field: sort(), desc: desc() }],
    }),
    (page) => setPageIndex(page.pageIndex),
  );
  const rows = () => remote.state().page?.items ?? [];
  const rowMap = createMemo(
    () => new Map(rows().map((file) => [file.id, file])),
  );
  const localContents = createMemo(() => {
    const contents = new Map<string, FileMetaData>();
    for (const info of Object.values(
      appState.cache.cacheInfo,
    )) {
      if (
        !info.isComplete ||
        !info.contentKey ||
        !info.fingerprint
      )
        continue;
      const key = contentKey(info.fingerprint);
      // References may have different IDs and names; preview the same local bytes.
      if (!contents.get(key)?.file) contents.set(key, info);
    }
    return contents;
  });
  const localFile = (file: ProtocolFileMetadata) =>
    file.fingerprint
      ? localContents().get(contentKey(file.fingerprint))
          ?.file
      : undefined;
  const available = (file: ProtocolFileMetadata) =>
    !!file.fingerprint &&
    localContents().has(contentKey(file.fingerprint));
  const taskFor = (file: ProtocolFileMetadata) => {
    const task = app.sharedFiles.downloadTask(
      props.peerId,
      file.id,
      file.fingerprint,
    );
    // Cancelled tasks remain in task history; directory rows return to their initial state.
    return task?.status === "cancelled" ||
      (task?.status === "completed" && !available(file))
      ? undefined
      : task;
  };
  const selectable = (file: ProtocolFileMetadata) => {
    const task = taskFor(file);
    return (
      !available(file) && (!task || !isActiveTask(task))
    );
  };
  const selectableRows = () => rows().filter(selectable);
  const sortLabel = (field: string | undefined) =>
    t(
      `file_library.sort_${field === "fileSize" ? "size" : field === "createdAt" ? "recent" : "name"}`,
    );
  createEffect(() => {
    const ids = new Set(
      selectableRows().map((file) => file.id),
    );
    setSelected((previous) =>
      previous.filter((id) => ids.has(id)),
    );
  });
  const hasPage = () =>
    connected() &&
    supported() &&
    !!remote.state().page?.sharingEnabled;
  const canGet = () => hasPage() && !remote.state().stale;
  const getFiles = (files: ProtocolFileMetadata[]) => {
    if (!canGet()) return;
    // These application-lifetime operations intentionally outlive this view.
    for (const file of files.filter(selectable))
      void app.sharedFiles
        .download(props.peerId, file)
        .catch(report);
    setSelected([]);
  };
  const empty = () =>
    !connected()
      ? "disconnected"
      : !supported()
        ? "unsupported"
        : remote.state().loading
          ? "loading"
          : remote.state().error
            ? "error"
            : remote.state().page?.sharingEnabled === false
              ? "disabled"
              : "empty";
  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="shrink-0 space-y-3 border-b p-3">
        <div class="flex items-center gap-2">
          <div class="relative min-w-0 flex-1">
            <Search
              class="text-muted-foreground pointer-events-none absolute top-2.5
                left-2.5 size-4"
              aria-hidden="true"
            />
            <Input
              class="h-9 pl-8"
              type="search"
              value={search()}
              maxLength={256}
              placeholder={t("shared_files.search")}
              aria-label={t("shared_files.search")}
              onInput={(event) =>
                setSearch(event.currentTarget.value)
              }
            />
          </div>
          <Button
            size="icon"
            variant="ghost"
            class="size-9 shrink-0"
            disabled={!connected() || !supported()}
            aria-label={t("shared_files.refresh")}
            onClick={remote.refresh}
          >
            <RefreshCw
              class="size-4 motion-reduce:animate-none"
              classList={{
                "animate-spin": remote.state().loading,
              }}
            />
          </Button>
        </div>
        <div class="flex flex-wrap gap-2">
          <Select
            options={
              ["fileName", "fileSize", "createdAt"] as const
            }
            value={sort()}
            onChange={(value) => {
              if (!value) return;
              setSort(value);
              setPageIndex(0);
            }}
            itemComponent={(item) => (
              <SelectItem item={item.item}>
                {sortLabel(item.item.rawValue)}
              </SelectItem>
            )}
          >
            <SelectTrigger
              class="w-32"
              aria-label={t("file_library.sort")}
            >
              <SelectValue<string>>
                {(state) =>
                  sortLabel(state.selectedOption())
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <Button
            size="sm"
            variant="ghost"
            class="h-9"
            onClick={() => {
              setDesc((value) => !value);
              setPageIndex(0);
            }}
          >
            {t(
              desc()
                ? "shared_files.desc"
                : "shared_files.asc",
            )}
          </Button>
          <Button
            size="sm"
            variant="secondary"
            class="ml-auto h-9"
            disabled={!canGet() || !selected().length}
            onClick={() =>
              getFiles(
                rows().filter((file) =>
                  selected().includes(file.id),
                ),
              )
            }
          >
            {t("shared_files.get_count", {
              count: selected().length,
            })}
          </Button>
        </div>
      </div>
      <Show
        when={
          hasPage() && rows().length && remote.state().error
        }
      >
        {(error) => (
          <p
            role="status"
            class="text-destructive px-3 py-2 text-xs"
          >
            {userErrorMessage(
              error(),
              "errors.file_list_failed",
            )}
          </p>
        )}
      </Show>
      <div
        class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto
          overscroll-contain p-1.5"
        aria-busy={remote.state().loading}
      >
        <Show
          when={hasPage() && rows().length}
          fallback={
            <div
              role="status"
              class="text-muted-foreground flex flex-1 flex-col items-center
                justify-center gap-3.5 p-[30px] text-center text-[13px]"
            >
              <Show
                when={empty() === "loading"}
                fallback={
                  <FolderOpen
                    class="size-[30px] opacity-55"
                    aria-hidden="true"
                  />
                }
              >
                <LoaderCircle
                  class="size-[30px] animate-spin opacity-55
                    motion-reduce:animate-none"
                  aria-hidden="true"
                />
              </Show>
              <p>{t(`shared_files.${empty()}`)}</p>
              <Show when={remote.state().error}>
                <span class="mt-2 block">
                  {userErrorMessage(
                    remote.state().error,
                    "errors.file_list_failed",
                  )}
                </span>
              </Show>
            </div>
          }
        >
          <div
            class="text-muted-foreground flex items-center gap-2 px-3 py-2
              text-xs"
          >
            <Checkbox
              checked={
                !!selectableRows().length &&
                selected().length ===
                  selectableRows().length
              }
              disabled={!selectableRows().length}
              onChange={(checked) =>
                setSelected(
                  checked
                    ? selectableRows().map(
                        (file) => file.id,
                      )
                    : [],
                )
              }
              class="flex items-center gap-2"
            >
              <CheckboxControl />
              <CheckboxLabel>
                {t("shared_files.select_all")}
              </CheckboxLabel>
            </Checkbox>
          </div>
          <ul class="space-y-1">
            <For each={[...rowMap().keys()]}>
              {(id) => (
                <SharedFileRow
                  file={rowMap().get(id)!}
                  task={taskFor(rowMap().get(id)!)}
                  available={available(rowMap().get(id)!)}
                  localFile={localFile(rowMap().get(id)!)}
                  selectable={selectable(rowMap().get(id)!)}
                  connected={connected()}
                  canGet={canGet()}
                  selected={selected().includes(id)}
                  onSelect={(checked) =>
                    setSelected((previous) =>
                      checked
                        ? [...previous, id]
                        : previous.filter(
                            (selectedId) =>
                              selectedId !== id,
                          ),
                    )
                  }
                  onGet={() =>
                    getFiles([rowMap().get(id)!])
                  }
                  onPreview={(file) =>
                    void preview.open(file).catch(report)
                  }
                />
              )}
            </For>
          </ul>
        </Show>
      </div>
      <div
        class="text-muted-foreground flex shrink-0 flex-wrap items-center
          gap-2 border-t p-3 text-xs"
      >
        <Button
          size="sm"
          variant="ghost"
          disabled={!canGet() || pageIndex() === 0}
          onClick={() => setPageIndex((value) => value - 1)}
        >
          {t("shared_files.previous")}
        </Button>
        <span>
          {pageIndex() + 1} /{" "}
          {Math.max(
            1,
            Math.ceil(
              (remote.state().page?.totalCount ?? 0) /
                pageSize(),
            ),
          )}
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={
            !canGet() ||
            (pageIndex() + 1) * pageSize() >=
              (remote.state().page?.totalCount ?? 0)
          }
          onClick={() => setPageIndex((value) => value + 1)}
        >
          {t("shared_files.next")}
        </Button>
        <Select
          class="ml-auto"
          options={[25, 50, 100]}
          value={pageSize()}
          onChange={(value) => {
            if (!value) return;
            setPageSize(value);
            setPageIndex(0);
          }}
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {item.item.rawValue}
            </SelectItem>
          )}
        >
          <SelectTrigger
            class="h-8 w-20 text-xs"
            aria-label={t("shared_files.page_size")}
          >
            <SelectValue<number>>
              {(state) => state.selectedOption()}
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
    </div>
  );
}

export function SharedFilesPanel(props: {
  active: boolean;
  split: boolean;
  member?: string;
  browsing: boolean;
  onBack(): void;
  onSelect(id: string): void;
}) {
  const peers = createMemo(() =>
    Object.values(appState.session.clientViewData).filter(
      Boolean,
    ),
  );
  const local = () =>
    props.member === appState.profile.clientId;
  const selectedPeer = () =>
    peers().find((peer) => peer.clientId === props.member);
  const name = () =>
    local()
      ? t("shared_files.mine")
      : (selectedPeer()?.name ?? props.member ?? "");
  const rowClass = (selected: boolean) =>
    cn(
      "group flex min-w-0 items-center rounded-xl px-1 transition-colors",
      selected ? "bg-primary/10" : "hover:bg-muted/60",
    );
  return (
    <SidebarBrowser
      split={props.split}
      browsing={props.browsing}
      list={
        <aside class="flex h-full min-h-0 w-full flex-col overflow-hidden">
          <header class="flex shrink-0 items-center gap-2 border-b p-3">
            <FolderOpen
              class="text-primary size-5"
              aria-hidden="true"
            />
            <h2 class="flex-1 text-sm font-semibold">
              {t("shared_files.title")}
            </h2>
          </header>
          <div
            class="scrollbar-thin min-h-0 flex-1 overflow-y-auto
              overscroll-contain p-1.5"
          >
            <ul class="space-y-1">
              <li class={rowClass(local())}>
                <button
                  type="button"
                  class="focus-visible:ring-ring flex min-w-0 flex-1 items-center
                    gap-3 rounded-xl p-2 text-left outline-none
                    focus-visible:ring-2"
                  aria-label={t("shared_files.mine")}
                  aria-pressed={local()}
                  onClick={() =>
                    props.onSelect(
                      appState.profile.clientId,
                    )
                  }
                >
                  <span
                    class="bg-primary/10 text-primary flex size-10 shrink-0
                      items-center justify-center rounded-full"
                    aria-hidden="true"
                  >
                    <FolderOpen class="size-5" />
                  </span>
                  <span class="min-w-0 flex-1 space-y-1">
                    <span class="block truncate text-sm font-semibold">
                      {t("shared_files.mine")}
                    </span>
                    <span class="text-muted-foreground block truncate text-xs">
                      {t("shared_files.choose")}
                    </span>
                  </span>
                </button>
              </li>
              <For each={peers()}>
                {(peer) => (
                  <li
                    class={rowClass(
                      props.member === peer.clientId,
                    )}
                  >
                    <button
                      type="button"
                      class="focus-visible:ring-ring flex min-w-0 flex-1 items-center
                        gap-3 rounded-xl p-2 text-left outline-none
                        focus-visible:ring-2"
                      aria-label={peer.name}
                      aria-pressed={
                        props.member === peer.clientId
                      }
                      title={peer.name}
                      onClick={() =>
                        props.onSelect(peer.clientId)
                      }
                    >
                      <span class="relative shrink-0">
                        <ClientAvatar
                          class="size-10"
                          name={peer.name}
                          avatar={peer.avatar ?? undefined}
                        />
                        <Show
                          when={
                            peer.onlineStatus === "online"
                          }
                        >
                          <span
                            class="border-background absolute right-0 bottom-0 size-2.5
                              rounded-full border-2 bg-emerald-500"
                            aria-hidden="true"
                          />
                        </Show>
                      </span>
                      <span class="min-w-0 flex-1 space-y-1">
                        <span class="block truncate text-sm font-semibold">
                          {peer.name}
                        </span>
                        <span class="text-muted-foreground block truncate text-xs">
                          {t(
                            `common.status.${peer.onlineStatus}`,
                          )}
                        </span>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </div>
        </aside>
      }
    >
      <Show
        when={props.member}
        keyed
        fallback={
          <div
            class="text-muted-foreground flex flex-1 flex-col items-center
              justify-center gap-3.5 p-[30px] text-center text-[13px]"
          >
            <FolderOpen
              class="size-[30px] opacity-55"
              aria-hidden="true"
            />
            <p>{t("shared_files.select_member")}</p>
          </div>
        }
      >
        {(member) => (
          <section class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <header
              class="border-border bg-background/80 flex w-full shrink-0
                items-center gap-2 border-b p-3 backdrop-blur"
            >
              <Show when={!props.split}>
                <Button
                  size="icon"
                  variant="ghost"
                  class="shrink-0"
                  aria-label={t("shared_files.back")}
                  title={t("shared_files.back")}
                  onClick={props.onBack}
                >
                  <ChevronLeft class="size-5" />
                </Button>
              </Show>
              <Show
                when={local()}
                fallback={
                  <ClientAvatar
                    class="size-9 shrink-0"
                    name={name()}
                    avatar={
                      selectedPeer()?.avatar ?? undefined
                    }
                  />
                }
              >
                <span
                  class="bg-primary/10 text-primary flex size-9 shrink-0 items-center
                    justify-center rounded-full"
                  aria-hidden="true"
                >
                  <FolderOpen class="size-5" />
                </span>
              </Show>
              <div class="min-w-0 flex-1">
                <h2
                  class="truncate text-sm font-semibold"
                  title={name()}
                >
                  {name()}
                </h2>
                <p class="text-muted-foreground truncate text-xs">
                  {local()
                    ? t("shared_files.choose")
                    : t(
                        `common.status.${selectedPeer()?.onlineStatus ?? "leave"}`,
                      )}
                </p>
              </div>
              <Show when={local()}>
                <SharedFileMenu />
              </Show>
            </header>
            <Show
              when={local()}
              fallback={
                <RemoteSharedFiles
                  peerId={member}
                  active={props.active}
                />
              }
            >
              <MySharedFiles />
            </Show>
          </section>
        )}
      </Show>
    </SidebarBrowser>
  );
}
