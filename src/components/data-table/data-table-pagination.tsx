import type { Table } from "@tanstack/solid-table";
import { For } from "solid-js";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/input";
import { IconChevronLeft } from "@/components/icons";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";

export function DataTablePagination<T>(props: {
  table: Table<T>;
  disabled?: boolean;
}) {
  return (
    <div
      class="flex flex-wrap items-center justify-between gap-2 border-t
        p-2 text-sm"
    >
      <span>
        {t("common.pagination.total", {
          count: props.table.getRowCount(),
        })}
      </span>
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-2">
          <span>{t("common.pagination.page_size")}</span>
          <select
            class={cn(inputClass, "h-8 w-20 px-2")}
            aria-label={t("common.pagination.page_size")}
            value={
              props.table.getState().pagination.pageSize
            }
            disabled={props.disabled}
            onChange={(event) =>
              props.table.setPageSize(
                Number(event.currentTarget.value),
              )
            }
          >
            <For each={[10, 25, 50, 100]}>
              {(size) => (
                <option value={size}>{size}</option>
              )}
            </For>
          </select>
        </label>
        <span class="tabular-nums">
          {t("common.pagination.page", {
            page:
              props.table.getState().pagination.pageIndex +
              1,
            count: Math.max(1, props.table.getPageCount()),
          })}
        </span>
        <Button
          size="icon"
          variant="outline"
          class="size-8"
          aria-label={t("common.pagination.previous")}
          disabled={
            props.disabled ||
            !props.table.getCanPreviousPage()
          }
          onClick={() => props.table.previousPage()}
        >
          <IconChevronLeft class="size-5" />
        </Button>
        <Button
          size="icon"
          variant="outline"
          class="size-8"
          aria-label={t("common.pagination.next")}
          disabled={
            props.disabled || !props.table.getCanNextPage()
          }
          onClick={() => props.table.nextPage()}
        >
          <IconChevronLeft class="size-5 rotate-180" />
        </Button>
      </div>
    </div>
  );
}
