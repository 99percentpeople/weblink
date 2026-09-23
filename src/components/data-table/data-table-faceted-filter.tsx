import { Column } from "@tanstack/solid-table";
import {
  Component,
  createEffect,
  createMemo,
  createSignal,
  For,
} from "solid-js";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Badge } from "../ui/badge";
import {
  IconAddCircle,
  IconCheck,
  IconClose,
} from "../icons";
import { Button } from "../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../ui/command";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";
import { Separator } from "../ui/seprartor";

interface DataTableFacetedFilterProps<TData, TValue> {
  column?: Column<TData, TValue>;
  title?: string;
  options: {
    label: string;
    value: string;
    icon?: Component<{ class?: string }>;
  }[];
}

export function DataTableFacetedFilter<TData, TValue>(
  props: DataTableFacetedFilterProps<TData, TValue>,
) {
  const facets = props.column?.getFacetedUniqueValues();
  const [selectedValues, setSelectedValues] = createSignal<
    string[]
  >((props.column?.getFilterValue() as string[]) ?? []);

  createEffect(() => {
    const values =
      props.column?.getFilterValue() as string[];
    if (values) {
      setSelectedValues(values);
    }
  });

  return (
    <Popover gutter={12} modal>
      <PopoverTrigger
        as={Button}
        variant="outline"
        size="sm"
        class="h-8 border-dashed"
      >
        <PopoverAnchor class="flex items-center">
          <IconAddCircle class="mr-1 size-4" />
          <span class="text-nowrap">{props.title}</span>
        </PopoverAnchor>
        {selectedValues().length > 0 && (
          <>
            <Separator
              orientation="vertical"
              class="mx-2 h-4"
            />
            <Badge
              variant="secondary"
              class="rounded-sm px-1 font-mono font-normal lg:hidden"
            >
              {selectedValues().length}
            </Badge>
            <div class="hidden space-x-1 lg:flex">
              {selectedValues().length > 2 ? (
                <Badge
                  variant="secondary"
                  class="rounded-sm px-1 font-normal"
                >
                  {selectedValues().length}{" "}
                  {t("common.file_table.filter.selected")}
                </Badge>
              ) : (
                props.options
                  .filter((option) =>
                    selectedValues().includes(option.value),
                  )
                  .map((option) => (
                    <Badge
                      variant="secondary"
                      class="rounded-sm px-1 font-normal"
                    >
                      {option.label}
                    </Badge>
                  ))
              )}
            </div>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent class="w-48 overflow-hidden p-0">
        <Command>
          <CommandInput placeholder={props.title} />
          <CommandList>
            <CommandEmpty>No results found.</CommandEmpty>
            <CommandGroup>
              <For each={props.options}>
                {(option) => {
                  const isSelected = createMemo(() =>
                    selectedValues().includes(option.value),
                  );
                  return (
                    <CommandItem
                      onSelect={() => {
                        if (isSelected()) {
                          setSelectedValues(
                            selectedValues().filter(
                              (value) =>
                                value !== option.value,
                            ),
                          );
                        } else {
                          setSelectedValues([
                            ...selectedValues(),
                            option.value,
                          ]);
                        }
                        const filterValues = Array.from(
                          selectedValues(),
                        );
                        props.column?.setFilterValue(
                          filterValues.length
                            ? filterValues
                            : [],
                        );
                      }}
                    >
                      <div
                        class={cn(
                          `border-primary mr-2 flex h-4 w-4 items-center justify-center
                          rounded-sm border`,
                          isSelected()
                            ? "bg-primary text-primary-foreground"
                            : "opacity-50 [&_svg]:invisible",
                        )}
                      >
                        <IconCheck class="size-4" />
                      </div>
                      {option.icon && (
                        <option.icon class="text-muted-foreground mr-2 h-4 w-4" />
                      )}
                      <span>{option.label}</span>
                      {facets?.get(option.value) && (
                        <span
                          class="ml-auto flex h-4 w-4 items-center justify-center font-mono
                            text-xs"
                        >
                          {facets.get(option.value)}
                        </span>
                      )}
                    </CommandItem>
                  );
                }}
              </For>
            </CommandGroup>
            {selectedValues().length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      props.column?.setFilterValue(
                        undefined,
                      );
                      setSelectedValues([]);
                    }}
                    class="justify-center text-center"
                  >
                    {t(
                      "common.file_table.filter.clear_filters",
                    )}
                  </CommandItem>
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
