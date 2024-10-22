import { FileMetaData } from "@/libs/cache/chunk-cache";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
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
  getFacetedMinMaxValues,
  getFacetedRowModel,
  getFacetedUniqueValues,
  getFilteredRowModel,
  getSortedRowModel,
  RowSelectionState,
  SortingState,
  VisibilityState,
} from "@tanstack/solid-table";
import { getCommonPinningStyles } from "@/components/data-table/data-table-pin-style";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuItemLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/libs/cn";
import { cacheManager } from "@/libs/services/cache-serivce";
import {
  Checkbox,
  CheckboxControl,
} from "@/components/ui/checkbox";
import {
  IconClose700,
  IconDelete,
  IconDownload,
  IconMenu,
  IconMoreHoriz,
  IconPageInfo,
  IconPreview,
  IconSearch700,
} from "@/components/icons";
import { createDialog } from "@/components/dialogs/dialog";
import { t } from "@/i18n";
import { createPreviewDialog } from "@/components/preview-dialog";
import {
  createElementSize,
  Size,
} from "@solid-primitives/resize-observer";
import { createStore, reconcile } from "solid-js/store";
import { DataTableColumnHeader } from "@/components/data-table/data-table-column-header";

const createComfirmDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: () =>
      t("common.confirm_delete_files_dialog.title"),
    description: () =>
      t("common.confirm_delete_files_dialog.description"),
    content: () =>
      t("common.confirm_delete_files_dialog.content"),

    cancel: (
      <Button onClick={() => close()}>
        {t("common.action.cancel")}
      </Button>
    ),
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        {t("common.action.confirm")}
      </Button>
    ),
  });

  return { open, Component };
};

export default function File() {
  const columnHelper = createColumnHelper<FileMetaData>();

  const {
    open: openPreviewDialog,
    Component: PreviewDialogComponent,
  } = createPreviewDialog();

  onMount(() => {
    reset();
  });

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
        <p class="max-w-xs overflow-hidden text-ellipsis">
          {info.getValue()}
        </p>
      ),
      enableGlobalFilter: true,
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
      cell: (info) => info.getValue() ?? "-",
      enableSorting: false,
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
            <DropdownMenuContent class="w-48">
              <Show when={row.original.file}>
                {(file) => (
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(file());
                      a.download = file().name;
                      a.click();
                    }}
                  >
                    <IconDownload class="size-4" />
                    {t("common.action.download")}
                  </DropdownMenuItem>
                )}
              </Show>
              <Show when={row.original.file}>
                {(file) => (
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      openPreviewDialog(file());
                    }}
                  >
                    <IconPreview class="size-4" />
                    {t("common.action.preview")}
                  </DropdownMenuItem>
                )}
              </Show>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="gap-2"
                onSelect={async () => {
                  cacheManager.remove(row.original.id);
                }}
              >
                <IconDelete class="size-4" />
                {t("common.action.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ),
      size: 0,
      enableSorting: false,
      enableHiding: false,
    }),
  ];

  const caches = cacheManager.caches;

  const [storage, setStorage] =
    createSignal<StorageEstimate | null>(null);

  createEffect(async () => {
    if (Object.values(cacheManager.caches).length >= 0) {
      const estimate = await navigator.storage.estimate();
      setStorage(estimate);
    }
  });

  const [columnFilters, setColumnFilters] =
    createSignal<ColumnFiltersState>([]);
  const data = createMemo(
    () =>
      Object.values(caches)
        .map((cache) => cache.info())
        .filter((info) => info) as FileMetaData[],
  );
  const [globalFilter, setGlobalFilter] = createSignal("");
  const [rowSelection, setRowSelection] =
    createSignal<RowSelectionState>({});
  const [columnPinning, setColumnPinning] =
    createSignal<ColumnPinningState>({
      left: ["select"],
      right: ["actions"],
    });
  const [columnVisibility, setColumnVisibility] =
    createSignal<VisibilityState>({});

  const [sorting, setSorting] = createSignal<SortingState>(
    [],
  );

  const table = createSolidTable({
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
    globalFilterFn: "includesString",
    onColumnPinningChange: setColumnPinning,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    onSortingChange: setSorting,
    onColumnVisibilityChange: setColumnVisibility,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getFacetedMinMaxValues: getFacetedMinMaxValues(),

    getRowId: (row) => row.id,
  });

  const [tableBody, setTableBody] = createSignal<
    HTMLElement | undefined
  >();
  const size = createElementSize(tableBody);

  const [tableCellSizes, setTableCellSizes] = createStore<
    Size[]
  >([]);

  const { open, Component: DialogComponent } =
    createComfirmDialog();
  return (
    <>
      <DialogComponent />
      <PreviewDialogComponent class="w-full" />
      <div class="container flex min-h-[calc(100%-3rem)] flex-col gap-4 py-4">
        <h2 class="h2">{t("cache.title")}</h2>
        <Show when={storage()}>
          {(storage) => (
            <Progress
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
        <div
          class="sticky top-12 z-10 flex gap-2 bg-background/80 py-2
            backdrop-blur-sm"
        >
          <Show
            when={Object.keys(rowSelection()).length !== 0}
          >
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button
                  variant="outline"
                  class="text-nowrap"
                >
                  <IconMenu class="mr-2 size-4" />
                  {t("common.action.actions")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-48">
                <DropdownMenuItem
                  class="gap-2"
                  onSelect={() => {
                    table
                      .getSelectedRowModel()
                      .rows.forEach((row) => {
                        const a =
                          document.createElement("a");
                        if (!row.original.file) return;
                        a.href = URL.createObjectURL(
                          row.original.file,
                        );
                        a.download = row.original.fileName;
                        a.click();
                      });
                    table.resetRowSelection();
                  }}
                >
                  <IconDownload class="size-4" />
                  {t("common.action.download")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="gap-2"
                  onSelect={() => table.resetRowSelection()}
                >
                  <IconClose700 class="size-4" />
                  {t("common.action.cancel")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="gap-2"
                  onSelect={async () => {
                    if ((await open()).cancel) return;
                    table
                      .getSelectedRowModel()
                      .rows.forEach((row) => {
                        cacheManager.remove(
                          row.original.id,
                        );
                      });
                    table.resetRowSelection();
                  }}
                >
                  <IconDelete class="size-4" />
                  {t("common.action.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
          <label
            tabIndex="0"
            class={cn(
              inputClass,
              `flex w-full max-w-md items-center gap-2 px-2
              focus-within:ring-1 focus-within:ring-ring`,
            )}
          >
            <IconSearch700 class="size-5 text-muted-foreground" />

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
          <DropdownMenu>
            <DropdownMenuTrigger
              as={Button}
              variant="outline"
              class="ml-auto gap-2"
            >
              <IconPageInfo class="size-4" />
              <span class="text-nowrap">
                {t("common.action.view")}
              </span>
            </DropdownMenuTrigger>
            <DropdownMenuContent class="w-48">
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel>
                  {t("common.file_table.toggle_columns")}
                </DropdownMenuGroupLabel>

                <DropdownMenuSeparator />
                <For
                  each={table
                    .getAllColumns()
                    .filter((column) =>
                      column.getCanHide(),
                    )}
                >
                  {(column) => (
                    <DropdownMenuCheckboxItem
                      checked={column.getIsVisible()}
                      onChange={(isChecked) =>
                        column.toggleVisibility(!!isChecked)
                      }
                    >
                      {column.id}
                    </DropdownMenuCheckboxItem>
                  )}
                </For>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="gap-2"
                onSelect={() =>
                  table.resetColumnVisibility()
                }
              >
                <IconClose700 class="size-4" />
                {t("common.action.reset")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div class="flex flex-1 flex-col-reverse">
          <div
            data-sync-scroll="file-table"
            class="syncscroll h-full w-full flex-1 overflow-x-auto"
          >
            <Table
              class="h-full w-full text-nowrap"
              ref={setTableBody}
            >
              <TableBody >
                <For
                  each={table.getRowModel().rows}
                  fallback={
                    <TableRow >
                      <TableCell
                        colSpan={columns.length}
                        class="h-24 text-center text-lg font-bold text-muted-foreground/50"
                      >
                        {t("common.file_table.no_data")}
                      </TableCell>
                    </TableRow>
                  }
                >
                  {(row, rowIndex) => (
                    <TableRow>
                      <For each={row.getVisibleCells()}>
                        {(cell, index) => (
                          <TableCell
                            ref={(ref) => {
                              createEffect(() => {
                                if (rowIndex() === 0) {
                                  setTableCellSizes(
                                    index(),
                                    undefined!,
                                  );

                                  setTableCellSizes(
                                    index(),
                                    createElementSize(ref),
                                  );
                                }
                              });
                            }}
                            class={cn(
                              cell.column.getIsPinned() &&
                                "bg-background transition-colors [tr:hover_&]:bg-muted",
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
            class="syncscroll sticky top-24 z-10 overflow-x-auto
              bg-background/80 backdrop-blur-sm"
          >
            <Table
              style={{
                width: `${size?.width}px`,
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
                                "bg-background transition-colors [tr:hover_&]:bg-muted",
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
        </div>
      </div>
    </>
  );
}
