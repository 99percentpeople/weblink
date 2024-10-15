import { FileMetaData } from "@/libs/cache/chunk-cache";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
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
  RowSelectionState,
} from "@tanstack/solid-table";
import { getCommonPinningStyles } from "@/components/data-table";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { cn } from "@/libs/cn";
import { cacheManager } from "@/libs/services/cache-serivce";
import { transferManager } from "@/libs/services/transfer-service";
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
  IconSearch700,
} from "@/components/icons";
import { createDialog } from "@/components/dialogs/dialog";

const createComfirmDialog = () => {
  const { open, close, submit, Component } = createDialog({
    title: "Delete Files",
    description: "This operation deletes selected files",
    content: () =>
      "Are you really sure you want to delete these files?",

    cancel: <Button onClick={() => close()}>Cancel</Button>,
    confirm: (
      <Button
        variant="destructive"
        onClick={() => submit(true)}
      >
        Confirm
      </Button>
    ),
  });

  return { open, Component };
};

export default function File() {
  const columnHelper = createColumnHelper<FileMetaData>();

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
      header: "Name",
      cell: (info) => (
        <p class="max-w-xs overflow-hidden text-ellipsis">
          {info.getValue()}
        </p>
      ),
      enableGlobalFilter: true,
    }),
    columnHelper.accessor("fileSize", {
      header: "Size",
      cell: (info) => formatBtyeSize(info.getValue(), 1),
    }),
    columnHelper.accessor("lastModified", {
      header: "Last Modify",
      cell: (info) => {
        const value = info.getValue();
        return value ? (
          new Date(value).toLocaleString()
        ) : (
          <></>
        );
      },
    }),
    columnHelper.display({
      id: "actions",
      cell: ({ row }) => (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger>
              <Button variant="ghost" size="icon">
                <IconMoreHoriz class="size-6" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <Show when={row.original.file}>
                {(file) => (
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      const a = document.createElement("a");
                      a.href = URL.createObjectURL(file());
                      a.download = file.name;
                      a.click();
                    }}
                  >
                    <IconDownload class="size-4" />
                    Download
                  </DropdownMenuItem>
                )}
              </Show>

              <DropdownMenuItem
                class="gap-2"
                onSelect={async () => {
                  cacheManager.remove(row.original.id);
                }}
              >
                <IconDelete class="size-4" />
                Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      ),
      size: 0,
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
    },
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    onColumnPinningChange: setColumnPinning,
    onColumnFiltersChange: setColumnFilters,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getFacetedRowModel: getFacetedRowModel(),
    getFacetedUniqueValues: getFacetedUniqueValues(),
    getFacetedMinMaxValues: getFacetedMinMaxValues(),

    debugTable: true,
    debugHeaders: true,
    debugColumns: false,

    getRowId: (row) => row.id,
  });
  const { open, Component: DialogComponent } =
    createComfirmDialog();
  return (
    <>
      <DialogComponent />
      <div class="container flex min-h-[calc(100%-3rem)] flex-col gap-4 py-4">
        <h2 class="h2">Cache</h2>

        <Show when={storage()}>
          {(storage) => (
            <Progress
              value={storage().usage}
              maxValue={storage().quota}
              getValueLabel={({ value, max }) =>
                `${formatBtyeSize(value)} used, ${formatBtyeSize(max)} total, ${formatBtyeSize(max - value)} remaining`
              }
            >
              <div class="muted mb-1 flex justify-end text-sm">
                <ProgressValueLabel />
              </div>
            </Progress>
          )}
        </Show>
        <div class="flex gap-2">
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
              placeholder="Search files ..."
              class="h-full w-full bg-transparent outline-none"
              value={globalFilter()}
              onInput={(ev) =>
                setGlobalFilter(ev.currentTarget.value)
              }
            />
          </label>
          <Show
            when={Object.keys(rowSelection()).length !== 0}
          >
            <DropdownMenu>
              <DropdownMenuTrigger>
                <Button variant="outline">
                  <IconMenu class="mr-2 size-4" />
                  Actions
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
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
                  Download
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="gap-2"
                  onSelect={() => table.resetRowSelection()}
                >
                  <IconClose700 class="size-4" />
                  Cancel
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
                  <IconDelete class="size-4" /> Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Show>
        </div>
        <div class="h-full w-full flex-1 overflow-x-auto">
          <Table class="h-full w-full text-nowrap">
            <TableHeader>
              <For each={table.getHeaderGroups()}>
                {(headerGroup) => (
                  <TableRow>
                    <For each={headerGroup.headers}>
                      {(header) => (
                        <TableHead
                          class={cn(
                            header.column.getIsPinned() &&
                              "bg-background transition-colors [tr:hover_&]:bg-muted",
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
              <For each={table.getRowModel().rows}>
                {(row) => (
                  <TableRow>
                    <For each={row.getVisibleCells()}>
                      {(cell) => (
                        <TableCell
                          class={cn(
                            cell.column.getIsPinned() &&
                              "bg-background transition-colors [tr:hover_&]:bg-muted",
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
      </div>
    </>
  );
}
