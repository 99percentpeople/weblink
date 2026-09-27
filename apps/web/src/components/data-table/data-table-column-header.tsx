import { Column } from "@tanstack/solid-table";

import { cn } from "@/libs/cn";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ComponentProps, Show } from "solid-js";
import {
  IconArrowDownward,
  IconArrowUpward,
  IconClose,
  IconUnfoldMore,
  IconVisibilityOff,
} from "../icons";
import { t } from "@/i18n";

interface DataTableColumnHeaderProps<TData, TValue>
  extends ComponentProps<"div"> {
  column: Column<TData, TValue>;
  title: string;
}

export function DataTableColumnHeader<TData, TValue>(
  props: DataTableColumnHeaderProps<TData, TValue>,
) {
  if (!props.column.getCanSort()) {
    return (
      <div class={cn("text-nowrap", props.class)}>
        {props.title}
      </div>
    );
  }

  return (
    <div class={cn("flex items-center gap-2", props.class)}>
      <DropdownMenu>
        <DropdownMenuTrigger
          as={Button}
          variant="ghost"
          class="h-8 gap-2 text-nowrap data-[state=open]:bg-accent"
          size="sm"
        >
          <span>{props.title}</span>
          {props.column.getIsSorted() === "desc" ? (
            <IconArrowDownward class="size-4" />
          ) : props.column.getIsSorted() === "asc" ? (
            <IconArrowUpward class="size-4" />
          ) : (
            <IconUnfoldMore class="size-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-32">
          <Show when={props.column.getIsSorted() !== "asc"}>
            <DropdownMenuItem
              class="gap-2"
              onClick={() =>
                props.column.toggleSorting(false)
              }
            >
              <IconArrowUpward class="size-3.5 text-muted-foreground/70" />
              {t("common.action.asc")}
            </DropdownMenuItem>
          </Show>
          <Show when={props.column.getIsSorted()}>
            <DropdownMenuItem
              class="gap-2"
              onClick={() => props.column.clearSorting()}
            >
              <IconClose class="size-3.5 text-muted-foreground/70" />
              {t("common.action.cancel")}
            </DropdownMenuItem>
          </Show>
          <Show
            when={props.column.getIsSorted() !== "desc"}
          >
            <DropdownMenuItem
              class="gap-2"
              onClick={() =>
                props.column.toggleSorting(true)
              }
            >
              <IconArrowDownward class="size-3.5 text-muted-foreground/70" />
              {t("common.action.desc")}
            </DropdownMenuItem>
          </Show>

          <DropdownMenuSeparator />
          <DropdownMenuItem
            class="gap-2"
            onClick={() =>
              props.column.toggleVisibility(false)
            }
          >
            <IconVisibilityOff class="size-3.5 text-muted-foreground/70" />
            {t("common.action.hide")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
