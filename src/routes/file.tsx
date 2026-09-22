import {
  batch,
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  For,
  JSX,
  onMount,
  Show,
} from "solid-js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { reset } from "@/libs/utils/syncscroll";
import {
  Progress,
  ProgressValueLabel,
} from "@/components/ui/progress";

import {
  ColumnFiltersState,
  ColumnPinningState,
  createColumnHelper,
  createSolidTable,
  flexRender,
  getCoreRowModel,
  getFacetedRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  RowSelectionState,
  SortingState,
  VisibilityState,
  Table as SolidTable,
} from "@tanstack/solid-table";
import { getCommonPinningStyles } from "@/components/data-table/data-table-pin-style";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/libs/cn";
import { cacheManager } from "@/libs/application/cache-service";
import { appState } from "@/libs/state/app-state";
import {
  Checkbox,
  CheckboxControl,
} from "@/components/ui/checkbox";
import {
  IconAdd,
  IconClose,
  IconClose700,
  IconDelete,
  IconDownload,
  IconFolder,
  IconForward,
  IconMenu,
  IconMerge,
  IconMoreHoriz,
  IconPlaceItem,
  IconPreview,
  IconSearch700,
  IconShare,
  IconWallpaper,
} from "@/components/icons";
import { t } from "@/i18n";
import { createPreviewDialog } from "@/components/dialogs/preview-dialog";
import {
  createElementSize,
  Size,
} from "@solid-primitives/resize-observer";
import { createStore } from "solid-js/store";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";
import { setAppOptions } from "@/options";
import { createForwardDialog } from "@/components/dialogs/forward-dialog";
import { FileMetaData } from "@/libs/cache";
import { downloadFile } from "@/libs/utils/download-file";
import DataTableColumnVisibility from "@/components/data-table/data-table-column-visibility";
import { makePersisted } from "@solid-primitives/storage";
import { PortableContextMenu } from "@/components/portable-contextmenu";
import { ContextMenuItem } from "@/components/ui/context-menu";
import {
  handleDropItems,
  handleSelectFolder,
} from "@/libs/utils/process-file";
import DropArea from "@/components/drop-area";
import { createComfirmDeleteItemsDialog } from "@/components/dialogs/confirm-delete-items-dialog";
import { Badge } from "@/components/ui/badge";
import { DataTableFacetedFilter } from "@/components/data-table/data-table-faceted-filter";
import { toast } from "solid-sonner";
import { catchError } from "@/libs/catch";
import { canShareFile } from "@/libs/utils/can-share";
import { IconFile } from "../components/icon-file";
import { getTotalChunkCount } from "@/libs/cache/chunk-cache";

const columnHelper = createColumnHelper<FileMetaData>();

const StorageStatus = (props: { class?: string }) => {
  if (!navigator.storage) {
    return <></>;
  }

  const [storage, setStorage] =
    createSignal<StorageEstimate | null>(null);

  createEffect(async () => {
    if (Object.values(appState.cache.caches).length >= 0) {
      const estimate = await navigator.storage.estimate();
      setStorage(estimate);
    }
  });

  return (
    <Show when={storage()}>
      {(storage) => (
        <Progress
          class={props.class}
          value={storage().usage}
          maxValue={storage().quota}
          getValueLabel={({ value, max }) =>
            t("cache.usage", {
              value: formatBtyeSize(value),
              max: formatBtyeSize(max),
              remaining: formatBtyeSize(max - value),
            })
          }
        >
          <div class="muted mb-1 flex justify-end text-sm">
            <ProgressValueLabel />
          </div>
        </Progress>
      )}
    </Show>
  );
};

export default function File() {
  const { open: openPreviewDialog } = createPreviewDialog();

  onMount(() => {
    reset();
  });

  const getStatus = (info: FileMetaData) => {
    if (info.isMerging) {
      return {
        label: t("common.file_table.status.merging"),
        value: "merging",
      };
    }
    return info.isComplete
      ? {
          label: t("common.file_table.status.complete"),
          value: "complete",
        }
      : {
          label: t("common.file_table.status.incomplete"),
          value: "incomplete",
        };
  };

  const { forwardCache: shareCache } =
    createForwardDialog();

  const columns = [
    columnHelper.display({
      id: "select",
      size: 0,
      header: ({ table }) => (
        <Checkbox
          role="checkbox"
          checked={table.getIsAllPageRowsSelected()}
          indeterminate={table.getIsSomePageRowsSelected()}
          onChange={(value) =>
            table.toggleAllPageRowsSelected(!!value)
          }
          aria-label="Select all"
        >
          <CheckboxControl />
        </Checkbox>
      ),

      cell: ({ row }) => (
        <Checkbox
          role="checkbox"
          checked={row.getIsSelected()}
          disabled={!row.getCanSelect()}
          onChange={(value) => row.toggleSelected(!!value)}
          aria-label="Select row"
        >
          <CheckboxControl />
        </Checkbox>
      ),
      enableSorting: false,
      enableHiding: false,
      enablePinning: true,

      enableColumnFilter: false,
      enableGlobalFilter: false,
    }),
    columnHelper.accessor("fileName", {
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.name")}
        />
      ),
      cell: (info) => (
        <div
          class="max-w-xs space-x-1 overflow-hidden text-ellipsis
            [&_*]:inline [&_svg]:size-4 [&>*]:align-middle"
          title={info.getValue()}
        >
          <IconFile mimetype={info.row.original.mimetype} />
          <span>{info.getValue()}</span>
        </div>
      ),
      enableGlobalFilter: true,
    }),
    columnHelper.display({
      id: "status",
      header: ({ column }) => (
        <DataTableColumnHeader
          column={column}
          title={t("common.file_table.columns.status")}
        />
      ),
      filterFn: (row, columnId, filterValue) => {
        const status = getStatus(row.original);
        return filterValue.length
          ? filterValue.includes(status.value)
          : true;
      },
      cell: ({ row }) => {
        const progress = createMemo(() => {
          if (!row.original.chunkCount) return 0;
          const totalChunkCount = getTotalChunkCount(
            row.original,
          );
          return (
            (row.original.chunkCount / totalChunkCount) *
            100
          );
        });
        return (
          <p
            class="flex max-w-xs items-center gap-1 overflow-hidden text-xs
              text-ellipsis"
          >
            <Badge variant="outline">
              {getStatus(row.original).label}
            </Badge>
            <Show when={!row.original.isComplete}>
              <span class="font-mono">
                {`${progress().toFixed(2)}%`}
              </span>
            </Show>
          </p>
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
        return value ? (
          new Date(value).toLocaleString()
        ) : (
          <></>
        );
      },
      sortingFn: (rowA, rowB) => {
        return (
          (rowA.original.createdAt ?? 0) -
          (rowB.original.createdAt ?? 0)
        );
      },
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
        return value ? (
          new Date(value).toLocaleString()
        ) : (
          <></>
        );
      },
      sortingFn: (rowA, rowB) => {
        return (
          (rowA.original.lastModified ?? 0) -
          (rowB.original.lastModified ?? 0)
        );
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
          {info.getValue() ?? "-"}
        </p>
      ),
    }),
    columnHelper.display({
      id: "actions",
      header: () => <div class="w-9" />,
      cell: ({ row }) => (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="ghost" size="icon">
                <IconMoreHoriz class="size-6" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-48">
              <DropdownMenuGroup>
                <Show when={row.original.file}>
                  {(file) => {
                    const shareableData = createMemo(() => {
                      if (!canShareFile(file()))
                        return null;
                      const shareData: ShareData = {
                        files: [file()],
                      };
                      return shareData;
                    });
                    return (
                      <>
                        <DropdownMenuItem
                          class="gap-2"
                          onSelect={() => {
                            downloadFile(file());
                          }}
                        >
                          <IconDownload class="size-4" />
                          {t("common.action.download")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          class="gap-2"
                          onSelect={() => {
                            openPreviewDialog(file());
                          }}
                        >
                          <IconPreview class="size-4" />
                          {t("common.action.preview")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          class="gap-2"
                          onSelect={() => {
                            shareCache([row.original]);
                          }}
                        >
                          <IconForward class="size-4" />
                          {t("common.action.forward")}
                        </DropdownMenuItem>
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
                        <Show
                          when={file().type.startsWith(
                            "image/",
                          )}
                        >
                          <DropdownMenuItem
                            class="gap-2"
                            onSelect={() => {
                              setAppOptions({
                                backgroundImage:
                                  row.original.id,
                              });
                            }}
                          >
                            <IconWallpaper class="size-4" />
                            {t(
                              "common.action.set_as_background",
                            )}
                          </DropdownMenuItem>
                        </Show>
                        <Show
                          when={
                            !row.original.isComplete &&
                            row.original.chunkCount ===
                              getTotalChunkCount(
                                row.original,
                              )
                          }
                        >
                          <DropdownMenuItem
                            class="gap-2"
                            onSelect={() => {
                              appState.cache.caches[
                                row.original.id
                              ]?.mergeFile();
                            }}
                          >
                            <IconMerge class="size-4" />
                            {t("common.action.merge")}
                          </DropdownMenuItem>
                        </Show>
                        <DropdownMenuSeparator />
                      </>
                    );
                  }}
                </Show>
                <DropdownMenuItem
                  variant="destructive"
                  class="gap-2"
                  onSelect={async () => {
                    if (
                      (
                        await openDeleteDialog([
                          row.original.fileName,
                        ])
                      ).result
                    ) {
                      cacheManager.remove(row.original.id);
                    }
                  }}
                >
                  <IconDelete class="size-4" />
                  {t("common.action.delete")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ),
      size: 0,
      enableSorting: false,
      enableHiding: false,
    }),
  ];

  const [columnFilters, setColumnFilters] = makePersisted(
    createSignal<ColumnFiltersState>([]),
    {
      name: "file-column-filters",
      storage: sessionStorage,
    },
  );
  const [columnVisibility, setColumnVisibility] =
    makePersisted(createSignal<VisibilityState>({}), {
      name: "file-column-visibility",
      storage: sessionStorage,
    });

  const [sorting, setSorting] = makePersisted(
    createSignal<SortingState>([]),
    {
      name: "file-sorting",
      storage: sessionStorage,
    },
  );
  const [globalFilter, setGlobalFilter] = createSignal("");
  const [rowSelection, setRowSelection] =
    createSignal<RowSelectionState>({});
  const [columnPinning, setColumnPinning] =
    createSignal<ColumnPinningState>({
      left: ["select"],
      right: ["actions"],
    });

  const data = createMemo(() =>
    appState.cache.status === "ready"
      ? Object.values(appState.cache.cacheInfo)
      : [],
  );

  // createEffect(() => {
  //   console.debug("get file data", data());
  // });

  const table: SolidTable<FileMetaData> = createSolidTable({
    get data() {
      return data();
    },
    columns,
    state: {
      get columnFilters() {
        return columnFilters();
      },
      get globalFilter() {
        return globalFilter();
      },
      get columnPinning() {
        return columnPinning();
      },
      get rowSelection() {
        return rowSelection();
      },
      get sorting() {
        return sorting();
      },
      get columnVisibility() {
        return columnVisibility();
      },
    },
    onGlobalFilterChange: setGlobalFilter,
    onColumnPinningChange: setColumnPinning,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    // getFacetedUniqueValues: getFacetedUniqueValues(),
    // getFacetedMinMaxValues: getFacetedMinMaxValues(),

    getRowId: (row) => row.id,

    // debugAll: true,
  });

  const [tableBody, setTableBody] = createSignal<
    HTMLElement | undefined
  >();
  const size = createElementSize(tableBody);

  const [tableCellSizes, setTableCellSizes] = createStore<
    Size[]
  >([]);

  const { open: openDeleteDialog } =
    createComfirmDeleteItemsDialog();
  return (
    <>
      <div
        class="bg-background/80 z-[10] container flex h-full
          min-h-[calc(100%-3rem)] w-full flex-col gap-4 px-0 pt-4"
      >
        <PortableContextMenu
          menu={(close) => (
            <>
              <ContextMenuItem
                as="label"
                class="gap-2"
                onSelect={() => {
                  close();
                }}
              >
                <input
                  class="hidden"
                  type="file"
                  // @ts-expect-error
                  webkitdirectory
                  mozdirectory
                  directory
                  onChange={async (ev) => {
                    if (!ev.currentTarget.files) return;
                    const abortController =
                      new AbortController();
                    const toastId = toast.loading(
                      t(
                        "common.notification.processing_files",
                      ),
                      {
                        duration: Infinity,
                        action: {
                          label: t("common.action.cancel"),
                          onClick: () =>
                            abortController.abort(
                              "User cancelled",
                            ),
                        },
                      },
                    );
                    const [error, file] = await catchError(
                      handleSelectFolder(
                        ev.currentTarget.files,
                        abortController.signal,
                      ),
                    );

                    toast.dismiss(toastId);

                    if (error) {
                      console.warn(error);
                      if (
                        error.message !== "User cancelled"
                      ) {
                        toast.error(error.message);
                      }
                      return;
                    }

                    const cache =
                      await cacheManager.createCache();
                    cache.setInfo({
                      fileName: file.name,
                      fileSize: file.size,
                      mimetype: file.type,
                      lastModified: file.lastModified,
                      chunkSize: appState.options.chunkSize,
                      createdAt: Date.now(),
                      file,
                    });
                  }}
                />
                <IconFolder class="size-4" />
                {t("common.action.add_folder")}
              </ContextMenuItem>
            </>
          )}
        >
          {(p) => (
            <label
              class="bg-muted/80 hover:bg-muted/90 fixed right-4 bottom-4 z-50
                flex size-12 items-center justify-center rounded-full
                shadow-md backdrop-blur hover:cursor-pointer"
              style={{
                right:
                  "calc(1rem + var(--scrollbar-width, 0px))",
              }}
              {...p}
            >
              <input
                type="file"
                class="hidden"
                multiple
                onChange={async (ev) => {
                  const files = ev.currentTarget.files;
                  for (const file of files ?? []) {
                    const cache =
                      await cacheManager.createCache();
                    cache.setInfo({
                      fileName: file.name,
                      fileSize: file.size,
                      mimetype: file.type,
                      lastModified: file.lastModified,
                      chunkSize: appState.options.chunkSize,
                      createdAt: Date.now(),
                      file,
                    });
                  }
                }}
              />
              <IconAdd class="size-8" />
            </label>
          )}
        </PortableContextMenu>
        <div class="pointer-events-none absolute inset-0 z-[-1] backdrop-blur" />
        <h3 class="h3 px-2">{t("cache.title")}</h3>
        <StorageStatus class="px-2" />
        <div
          class="sticky top-[var(--mobile-header-height)] z-10 flex gap-2 p-2
            backdrop-blur sm:top-0"
        >
          <Show
            when={Object.keys(rowSelection()).length !== 0}
          >
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button
                  variant="outline"
                  size="sm"
                  class="text-nowrap"
                >
                  <IconMenu class="mr-2 size-4" />
                  {t("common.action.actions")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      table
                        ?.getSelectedRowModel()
                        .rows.forEach((row) => {
                          if (!row.original.file) return;
                          downloadFile(row.original.file);
                        });
                      table.resetRowSelection();
                    }}
                  >
                    <IconDownload class="size-4" />
                    {t("common.action.download")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() =>
                      table.resetRowSelection()
                    }
                  >
                    <IconClose700 class="size-4" />
                    {t("common.action.cancel")}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      shareCache(
                        table
                          .getSelectedRowModel()
                          .rows.map((row) => row.original),
                      );
                      table.resetRowSelection();
                    }}
                  >
                    <IconForward class="size-4" />
                    {t("common.action.forward")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    class="gap-2"
                    onSelect={() => {
                      openDeleteDialog(
                        table
                          .getSelectedRowModel()
                          .rows.map(
                            (row) => row.original.fileName,
                          ),
                      ).then(({ result }) => {
                        if (result === true) {
                          table
                            .getSelectedRowModel()
                            .rows.forEach((row) => {
                              cacheManager.remove(
                                row.original.id,
                              );
                            });
                          table.resetRowSelection();
                        }
                      });
                    }}
                  >
                    <IconDelete class="size-4" />
                    {t("common.action.delete")}
                  </DropdownMenuItem>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
          <label
            tabIndex="0"
            class={cn(
              inputClass,
              `bg-background/80 focus-within:ring-ring flex h-8 w-full
              max-w-md items-center gap-2 px-2 focus-within:ring-1`,
            )}
          >
            <IconSearch700 class="text-muted-foreground size-5" />

            <input
              type="search"
              placeholder={t("cache.search_input")}
              class="h-full w-full bg-transparent outline-none"
              value={globalFilter()}
              onInput={(ev) =>
                setGlobalFilter(ev.currentTarget.value)
              }
            />
          </label>
          <DataTableFacetedFilter
            column={table.getColumn("status")}
            title={t("common.file_table.columns.status")}
            options={[
              {
                label: t(
                  "common.file_table.status.complete",
                ),
                value: "complete",
              },
              {
                label: t(
                  "common.file_table.status.merging",
                ),
                value: "merging",
              },
              {
                label: t(
                  "common.file_table.status.incomplete",
                ),
                value: "incomplete",
              },
            ]}
          />
          <DataTableColumnVisibility
            table={table}
            class="ml-auto"
          />
        </div>
        <DropArea
          class="relative flex h-full flex-col-reverse"
          overlay={(ev) => {
            if (!ev) return;
            if (ev.dataTransfer) {
              const hasFiles =
                ev.dataTransfer?.types.includes("Files");

              if (hasFiles) {
                ev.dataTransfer.dropEffect = "move";
              } else {
                ev.dataTransfer.dropEffect = "none";
              }
            }
            return (
              <div class="bg-muted/50 pointer-events-none absolute inset-0">
                <span
                  class="text-muted-foreground/20 absolute top-1/2 left-1/2
                    -translate-x-1/2 -translate-y-1/2"
                >
                  <Show
                    when={
                      ev.dataTransfer?.dropEffect === "move"
                    }
                    fallback={<IconClose class="size-32" />}
                  >
                    <IconPlaceItem class="size-32" />
                  </Show>
                </span>
              </div>
            );
          }}
          onDrop={async (ev) => {
            if (!ev.dataTransfer) return;
            const abortController = new AbortController();
            const toastId = toast.loading(
              t("common.notification.processing_files"),
              {
                duration: Infinity,
                action: {
                  label: t("common.action.cancel"),
                  onClick: () =>
                    abortController.abort("User cancelled"),
                },
              },
            );
            const [error, files] = await catchError(
              handleDropItems(
                ev.dataTransfer.items,
                abortController.signal,
              ),
            );
            toast.dismiss(toastId);
            if (error) {
              console.warn(error);
              if (error.message !== "User cancelled") {
                toast.error(error.message);
              }
              return;
            }

            for (const file of files) {
              const cache =
                await cacheManager.createCache();
              cache.setInfo({
                fileName: file.name,
                fileSize: file.size,
                mimetype: file.type,
                lastModified: file.lastModified,
                chunkSize: appState.options.chunkSize,
                createdAt: Date.now(),
                file,
              });
            }
          }}
        >
          <div
            data-sync-scroll="file-table"
            class="scrollbar-none sm:scrollbar-thin relative flex h-full w-full
              max-w-full flex-col overflow-x-auto sm:absolute sm:inset-0"
          >
            <Table
              class="mb-20 text-nowrap"
              ref={setTableBody}
            >
              <TableHeader
                class="bg-background/50 sticky top-0 z-10 hidden backdrop-blur
                  sm:table-header-group"
              >
                <For each={table.getHeaderGroups()}>
                  {(headerGroup) => (
                    <TableRow>
                      <For each={headerGroup.headers}>
                        {(header, index) => (
                          <TableHead
                            class={cn(
                              header.column.getIsPinned() &&
                                "bg-background/50 [tr:hover_&]:bg-muted transition-colors",
                            )}
                            style={{
                              ...getCommonPinningStyles(
                                header.column,
                              ),
                            }}
                          >
                            <Show
                              when={!header.isPlaceholder}
                            >
                              {flexRender(
                                header.column.columnDef
                                  .header,
                                header.getContext(),
                              )}
                            </Show>
                          </TableHead>
                        )}
                      </For>
                    </TableRow>
                  )}
                </For>
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
                        {t("common.file_table.no_data")}
                      </TableCell>
                    </TableRow>
                  }
                >
                  {(row, rowIndex) => (
                    <TableRow
                      onDblClick={() => {
                        if (row.original.file) {
                          openPreviewDialog(
                            row.original.file,
                          );
                        }
                      }}
                    >
                      <For each={row.getVisibleCells()}>
                        {(cell, index) => (
                          <TableCell
                            ref={(ref) => {
                              if (rowIndex() === 0) {
                                batch(() => {
                                  setTableCellSizes(
                                    index(),
                                    undefined!,
                                  );
                                  setTableCellSizes(
                                    index(),
                                    createElementSize(ref),
                                  );
                                });
                              }
                            }}
                            class={cn(
                              cell.column.getIsPinned() &&
                                `bg-background/50 [tr:hover_&]:bg-muted backdrop-blur
                                transition-colors`,
                            )}
                            style={{
                              ...getCommonPinningStyles(
                                cell.column,
                              ),
                              width: `${cell.column.getSize()}px`,
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
          <div
            data-sync-scroll="file-table"
            class="bg-background/50 scrollbar-thin sticky
              top-[calc(var(--mobile-header-height)+3rem)] z-10 block
              h-auto overflow-x-auto overflow-y-hidden backdrop-blur
              sm:top-12 sm:hidden"
          >
            <Table
              style={{
                width: `${size?.width ?? 0}px`,
              }}
            >
              <TableHeader>
                <For each={table.getHeaderGroups()}>
                  {(headerGroup) => (
                    <TableRow>
                      <For each={headerGroup.headers}>
                        {(header, index) => (
                          <TableHead
                            class={cn(
                              header.column.getIsPinned() &&
                                "bg-background/50 [tr:hover_&]:bg-muted transition-colors",
                            )}
                            style={{
                              ...getCommonPinningStyles(
                                header.column,
                              ),
                              width: `${
                                tableCellSizes[index()]
                                  ?.width ??
                                header.column.getSize()
                              }px`,
                            }}
                          >
                            <Show
                              when={!header.isPlaceholder}
                            >
                              {flexRender(
                                header.column.columnDef
                                  .header,
                                header.getContext(),
                              )}
                            </Show>
                          </TableHead>
                        )}
                      </For>
                    </TableRow>
                  )}
                </For>
              </TableHeader>
            </Table>
          </div>
        </DropArea>
      </div>
    </>
  );
}
