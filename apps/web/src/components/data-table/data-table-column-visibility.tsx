import { For } from "solid-js";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { IconPageInfo } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Table } from "@tanstack/solid-table";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";

interface DataTableColumnVisibilityProps<TData> {
  table: Table<TData>;
  class?: string;
}

export function DataTableColumnVisibility<TData>(
  props: DataTableColumnVisibilityProps<TData>,
) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as={Button}
        size="sm"
        variant="outline"
        class={cn("gap-2", props.class)}
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
            each={props.table
              .getAllColumns()
              .filter((column) => column.getCanHide())}
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
          class="justify-center gap-2"
          onSelect={() =>
            props.table.resetColumnVisibility()
          }
        >
          {t("common.action.reset")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export default DataTableColumnVisibility;
