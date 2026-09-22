import { findFileTransfer } from "@/libs/application/transfer/file-transfer-state";
import {
  IconCloudDownload,
  IconDelete,
  IconDownload,
  IconFolderMatch,
  IconMoreHoriz,
  IconPreview,
  IconResume,
  IconSearch700,
  IconShare,
  IconSync,
} from "@/components/icons";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import { ClientHeader } from "./components/client-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
} from "@/components/ui/dropdown-menu";
import { inputClass } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { t } from "@/i18n";
import type { ChunkMetaData } from "@/libs/domain/file";
import {
  STORAGE_SORT_FIELDS,
  STORAGE_MAX_SEARCH_LENGTH,
  type StorageSortField,
} from "@/libs/domain/protocol";
import { createRemoteCatalog } from "@/libs/hooks/file-catalog";
import { DataTablePagination } from "@/components/data-table/data-table-pagination";
import { cn } from "@/libs/cn";
import { useAppState } from "@/libs/state/app-state-context";
import type { Client } from "@/libs/domain/client";
import type { ClientInfo } from "@/libs/state/app-state";
import { downloadFile } from "@/libs/utils/download-file";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { makePersisted } from "@solid-primitives/storage";
import { useMatch, useParams } from "@solidjs/router";
import {
  createColumnHelper,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  functionalUpdate,
  type PaginationState,
  SortingState,
  ColumnPinningState,
  type Table as SolidTable,
  VisibilityState,
} from "@tanstack/solid-table";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import DataTableColumnVisibility from "@/components/data-table/data-table-column-visibility";
import { getCommonPinningStyles } from "@/components/data-table/data-table-pin-style";
import {
  batch,
  onCleanup,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  For,
  Show,
} from "solid-js";
import { createComfirmDeleteItemsDialog } from "@/components/dialogs/confirm-delete-items-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { catchError } from "@/libs/catch";
import { canShareFile } from "@/libs/utils/can-share";
import { IconFile } from "@/components/icon-file";
import { getTotalChunkCount } from "@/libs/domain/file";
import { appState } from "@/libs/state/app-state";

type ChunkStatus =
  | "not_started"
  | "stopped"
  | "transferring"
  | "merging"
  | "complete";

const Sync = () => {
  const { requestFile, catalog } = useAppState();
  const params = useParams<{ id: string }>();
  const syncMatch = useMatch(() => "/client/:id/sync");

  const columnHelper = createColumnHelper<ChunkMetaData>();

  const columns = [
    columnHelper.accessor("fileName", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.name")}
        />
      ),
      cell: (info) => (
        <p
          class="max-w-xs space-x-1 overflow-hidden text-ellipsis
            [&>*]:align-middle"
        >
          <IconFile
            mimetype={info.row.original.mimetype}
            class="inline size-4"
          />
          <span>{info.getValue()}</span>
        </p>
      ),
    }),
    columnHelper.display({
      id: "status",
      header: t("common.file_table.columns.status"),
      enableSorting: false,
      cell: ({ row }) => {
        const status = () => statusOf(row.original);
        const progress = createMemo(() => {
          const info =
            appState.cache.cacheInfo[row.original.id];
          if (!info?.chunkCount) return 0;
          return (
            (info?.chunkCount / getTotalChunkCount(info)) *
            100
          );
        });
        return (
          <div class="flex items-center gap-1 text-xs">
            <Badge variant="outline">
              {t(`common.file_table.status.${status()}`)}
            </Badge>
            <Show
              when={["transferring", "stopped"].includes(
                status(),
              )}
            >
              <span class="font-mono">
                {`${progress().toFixed(2)}%`}
              </span>
            </Show>
          </div>
        );
      },
    }),

    columnHelper.accessor("fileSize", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.size")}
        />
      ),
      cell: (info) => formatBtyeSize(info.getValue(), 1),
    }),
    columnHelper.accessor("createdAt", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.created_at")}
        />
      ),
      cell: (info) => {
        const value = info.getValue();
        return value
          ? new Date(value).toLocaleString()
          : "";
      },
      enableGlobalFilter: true,
    }),
    columnHelper.accessor("lastModified", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t(
            "common.file_table.columns.last_modified",
          )}
        />
      ),
      cell: (info) => {
        const value = info.getValue();
        return value
          ? new Date(value).toLocaleString()
          : "";
      },
    }),
    columnHelper.accessor("mimetype", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.mime_type")}
        />
      ),
      cell: (info) => (
        <p class="max-w-xs overflow-hidden text-ellipsis">
          {info.getValue()}
        </p>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <div class="w-9" />,
      cell: ({ row }) => {
        const localCache = createMemo(
          () => appState.cache.caches[row.original.id],
        );

        const status = () => statusOf(row.original);

        return (
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="ghost" size="icon">
                <IconMoreHoriz class="size-6" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-48">
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel>
                  {t("common.action.actions")}
                </DropdownMenuGroupLabel>
                <Show
                  when={localCache()}
                  fallback={
                    <Show
                      when={clientInfo()?.messageChannel}
                    >
                      <DropdownMenuItem
                        class="gap-2"
                        onSelect={() => {
                          console.log(
                            `request download`,
                            row.original,
                          );
                          requestFile(
                            params.id,
                            row.original,
                            false,
                          );
                        }}
                      >
                        <IconCloudDownload class="size-4" />
                        {t(
                          "common.action.request_download",
                        )}
                      </DropdownMenuItem>
                    </Show>
                  }
                >
                  {(cache) => {
                    const [file] = createResource(
                      async () =>
                        (await cache()?.getFile()) ?? null,
                    );
                    const shareableData = createMemo(() => {
                      const f = file();
                      if (!f) return null;
                      if (!canShareFile(f)) return null;
                      const shareData: ShareData = {
                        files: [f],
                      };
                      return shareData;
                    });
                    return (
                      <>
                        <Show
                          when={
                            appState.cache.cacheInfo[
                              row.original.id
                            ]?.isComplete
                          }
                        >
                          <Show when={file()}>
                            {(f) => (
                              <>
                                <DropdownMenuItem
                                  class="gap-2"
                                  onSelect={() => {
                                    openPreview(f());
                                  }}
                                >
                                  <IconPreview class="size-4" />
                                  {t(
                                    "common.action.preview",
                                  )}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  class="gap-2"
                                  onSelect={() => {
                                    downloadFile(f());
                                  }}
                                >
                                  <IconDownload class="size-4" />
                                  {t(
                                    "common.action.download",
                                  )}
                                </DropdownMenuItem>
                              </>
                            )}
                          </Show>
                          <Show when={shareableData()}>
                            {(shareData) => (
                              <DropdownMenuItem
                                class="gap-2"
                                onSelect={async () => {
                                  const [err] =
                                    await catchError(
                                      navigator.share(
                                        shareData(),
                                      ),
                                    );
                                  if (err) {
                                    console.error(err);
                                  }
                                }}
                              >
                                <IconShare class="size-4" />
                                {t("common.action.share")}
                              </DropdownMenuItem>
                            )}
                          </Show>
                        </Show>
                        <DropdownMenuItem
                          class="gap-2"
                          onSelect={() => {
                            openDeleteDialog([
                              row.original.fileName,
                            ]).then(({ result }) => {
                              if (result === true) {
                                cache().cleanup();
                              }
                            });
                          }}
                        >
                          <IconDelete class="size-4" />
                          {t("common.action.delete")}
                        </DropdownMenuItem>
                        <Show when={status() === "stopped"}>
                          <DropdownMenuItem
                            class="gap-2"
                            onSelect={() => {
                              requestFile(
                                params.id,
                                row.original,
                                true,
                              );
                            }}
                          >
                            <IconResume class="size-4" />
                            {t("common.action.resume")}
                          </DropdownMenuItem>
                        </Show>
                      </>
                    );
                  }}
                </Show>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
      enableHiding: false,
    }),
  ];

  const { open: openDeleteDialog } =
    createComfirmDeleteItemsDialog();

  const [columnPinning, setColumnPinning] =
    createSignal<ColumnPinningState>({
      left: [],
      right: ["actions"],
    });
  const [sorting, setSorting] = makePersisted(
    createSignal<SortingState>([]),
    {
      name: "storage-sorting",
      storage: sessionStorage,
    },
  );
  const [columnVisibility, setColumnVisibility] =
    makePersisted(createSignal<VisibilityState>({}), {
      name: "storage-column-visibility",
      storage: sessionStorage,
    });

  const [globalFilter, setGlobalFilter] = createSignal("");
  const [searchInput, setSearchInput] = createSignal("");
  const [pagination, setPagination] =
    createSignal<PaginationState>({
      pageIndex: 0,
      pageSize: 25,
    });
  const { open: openPreview } = createPreviewDialog();
  const session = createMemo(
    () => appState.session.sessions[params.id],
  );
  const client = createMemo<Client | undefined>(() =>
    appState.message.clients.find(
      (c) => c.clientId === params.id,
    ),
  );
  const clientInfo = createMemo<ClientInfo | undefined>(
    () => appState.session.clientViewData[params.id],
  );
  const connected = createMemo(
    () =>
      !!session() &&
      clientInfo()?.onlineStatus === "online" &&
      !!clientInfo()?.messageChannel,
  );
  // A route may stay mounted during navigation. Only the currently viewed peer's
  // sync route owns a subscription; leaving it cancels any pending page request.
  const activeSession = createMemo(() =>
    syncMatch()?.params.id === params.id && connected()
      ? session()
      : undefined,
  );
  const remote = createRemoteCatalog(
    catalog,
    activeSession,
    () => ({
      ...pagination(),
      search: globalFilter(),
      sort: sorting()
        .filter((sort) =>
          STORAGE_SORT_FIELDS.includes(
            sort.id as StorageSortField,
          ),
        )
        .map((sort) => ({
          field: sort.id as StorageSortField,
          desc: sort.desc,
        })),
    }),
    (page) =>
      setPagination((previous) =>
        previous.pageIndex === page.pageIndex
          ? previous
          : { ...previous, pageIndex: page.pageIndex },
      ),
  );
  const storage = () => remote.state().page?.items ?? [];
  const table: SolidTable<ChunkMetaData> = createSolidTable(
    {
      get data() {
        return storage();
      },
      get rowCount() {
        return remote.state().page?.totalCount ?? 0;
      },
      state: {
        get pagination() {
          return pagination();
        },
        get columnPinning() {
          return columnPinning();
        },
        get globalFilter() {
          return globalFilter();
        },
        get sorting() {
          return sorting();
        },
        get columnVisibility() {
          return columnVisibility();
        },
      },
      columns,
      manualPagination: true,
      manualFiltering: true,
      manualSorting: true,
      autoResetPageIndex: false,
      onPaginationChange: (updater) =>
        setPagination((previous) => {
          const next = functionalUpdate(updater, previous);
          return next.pageSize === previous.pageSize
            ? next
            : { ...next, pageIndex: 0 };
        }),
      onGlobalFilterChange: (updater) =>
        batch(() => {
          setGlobalFilter((previous) =>
            functionalUpdate(updater, previous),
          );
          setPagination((previous) => ({
            ...previous,
            pageIndex: 0,
          }));
        }),
      onSortingChange: (updater) =>
        batch(() => {
          setSorting((previous) =>
            functionalUpdate(updater, previous),
          );
          setPagination((previous) => ({
            ...previous,
            pageIndex: 0,
          }));
        }),
      onColumnPinningChange: setColumnPinning,
      onColumnVisibilityChange: setColumnVisibility,
      getCoreRowModel: getCoreRowModel(),
      getRowId: (row) => row.id,
    },
  );

  createEffect(() => {
    const search = searchInput();
    const timer = setTimeout(() => {
      if (table.getState().globalFilter !== search)
        table.setGlobalFilter(search);
    }, 250);
    onCleanup(() => clearTimeout(timer));
  });

  // Status is local download state, keyed by file ID rather than a stale row index.
  const statusOf = (chunk: ChunkMetaData): ChunkStatus => {
    const info = appState.cache.cacheInfo[chunk.id];
    if (!info) return "not_started";
    if (info.isMerging) return "merging";
    if (info.isComplete) return "complete";
    return findFileTransfer(
      appState.transfer.transfers,
      appState.profile.clientId,
      params.id,
      chunk.id,
    )
      ? "transferring"
      : "stopped";
  };

  return (
    <>
      <div class="bg-background/50 absolute inset-0 z-[-1] backdrop-blur"></div>
      <div class="bg-background/50 flex h-full w-full flex-col gap-2 p-0">
        <ClientHeader
          clientId={params.id}
          client={client()}
          info={clientInfo()}
          view="sync"
        />
        <Show
          when={connected()}
          fallback={
            <div
              role="status"
              class="flex min-h-0 flex-1 items-center justify-center p-6"
            >
              <div class="flex max-w-sm flex-col items-center gap-3 text-center">
                <div class="bg-muted rounded-full p-4">
                  <IconFolderMatch
                    class="text-muted-foreground size-8"
                    aria-hidden="true"
                  />
                </div>
                <h3 class="text-lg font-medium">
                  {t("client.sync.disconnected.title")}
                </h3>
                <p class="text-muted-foreground text-sm">
                  {t(
                    "client.sync.disconnected.description",
                  )}
                </p>
              </div>
            </div>
          }
        >
          <div class="flex flex-wrap items-center gap-2 p-2">
            <label
              tabIndex="0"
              class={cn(
                inputClass,
                `bg-background/80 focus-within:ring-ring flex h-8 max-w-md
                min-w-0 flex-1 items-center gap-2 px-2 focus-within:ring-1`,
              )}
            >
              <IconSearch700 class="text-muted-foreground size-5" />

              <input
                type="search"
                placeholder={t("client.sync.search_input")}
                aria-label={t("client.sync.search_input")}
                maxLength={STORAGE_MAX_SEARCH_LENGTH}
                class="h-full w-full bg-transparent outline-none"
                value={searchInput()}
                onInput={(ev) =>
                  setSearchInput(ev.currentTarget.value)
                }
              />
            </label>
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <Tooltip>
                <TooltipTrigger
                  as={Button}
                  type="button"
                  variant="outline"
                  size="icon"
                  class="size-8"
                  disabled={
                    !activeSession() ||
                    remote.state().loading
                  }
                  aria-label={t("client.sync.menu.refresh")}
                  onClick={remote.refresh}
                >
                  <IconSync
                    class="size-4"
                    classList={{
                      "animate-spin":
                        remote.state().loading,
                    }}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  {t("client.sync.menu.refresh")}
                </TooltipContent>
              </Tooltip>
              <DataTableColumnVisibility table={table} />
            </div>
          </div>

          <Show when={remote.state().error}>
            <div
              role="alert"
              class="text-destructive flex items-center justify-between gap-2
                px-2 text-sm"
            >
              <span>
                {t("client.sync.load_failed")}:{" "}
                {remote.state().error}
              </span>
              <Button
                variant="outline"
                size="sm"
                onClick={remote.refresh}
              >
                {t("client.sync.menu.refresh")}
              </Button>
            </div>
          </Show>
          <Show when={remote.state().loading}>
            <div
              role="status"
              class="text-muted-foreground px-2 text-sm"
            >
              {t("client.sync.loading")}
            </div>
          </Show>
          <Show
            when={
              remote.state().page?.sharingEnabled === false
            }
          >
            <div
              role="status"
              class="text-muted-foreground px-2 text-sm"
            >
              {t("client.sync.sharing_disabled")}
            </div>
          </Show>
          <div
            class="relative min-h-0 w-full flex-1 overflow-auto"
            aria-busy={remote.state().loading}
          >
            <Table class="absolute inset-0 text-nowrap">
              <TableHeader class="bg-background/50 sticky top-0 z-10 backdrop-blur">
                <TableRow>
                  <For each={table.getHeaderGroups()}>
                    {(headerGroup) => (
                      <For each={headerGroup.headers}>
                        {(header) => (
                          <TableHead
                            class={cn(
                              header.column.getIsPinned() &&
                                `bg-background/50 [tr:hover_&]:bg-muted backdrop-blur
                                transition-colors`,
                            )}
                            style={{
                              ...getCommonPinningStyles(
                                header.column,
                              ),
                            }}
                          >
                            {flexRender(
                              header.column.columnDef
                                .header,
                              header.getContext(),
                            )}
                          </TableHead>
                        )}
                      </For>
                    )}
                  </For>
                </TableRow>
              </TableHeader>
              <TableBody>
                <For
                  each={table.getRowModel().rows}
                  fallback={
                    <TableRow>
                      <TableCell
                        colSpan={columns.length}
                        class="text-muted-foreground/50 h-24 text-center text-lg font-bold"
                      >
                        {remote.state().loading
                          ? t("client.sync.loading")
                          : t("common.file_table.no_data")}
                      </TableCell>
                    </TableRow>
                  }
                >
                  {(row) => (
                    <TableRow
                      onDblClick={() => {
                        const status = () =>
                          statusOf(row.original);
                        if (status() === "complete") {
                          const file =
                            appState.cache.cacheInfo[
                              row.original.id
                            ]?.file;
                          if (file) {
                            openPreview(file);
                          }
                        } else if (
                          [
                            "not_started",
                            "stopped",
                          ].includes(status())
                        ) {
                          const resume =
                            status() === "stopped";
                          requestFile(
                            params.id,
                            row.original,
                            resume,
                          );
                        }
                      }}
                    >
                      <For each={row.getVisibleCells()}>
                        {(cell) => (
                          <TableCell
                            class={cn(
                              cell.column.getIsPinned() &&
                                `bg-background/50 [tr:hover_&]:bg-muted backdrop-blur
                                transition-colors`,
                            )}
                            style={{
                              ...getCommonPinningStyles(
                                cell.column,
                              ),
                            }}
                          >
                            {flexRender(
                              cell.column.columnDef.cell,
                              cell.getContext(),
                            )}
                          </TableCell>
                        )}
                      </For>
                    </TableRow>
                  )}
                </For>
              </TableBody>
            </Table>
          </div>
          <DataTablePagination
            table={table}
            disabled={!activeSession()}
          />
        </Show>
      </div>
    </>
  );
};

export default Sync;
