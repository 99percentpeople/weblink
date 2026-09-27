import { For, Show } from "solid-js";
import { Search } from "lucide-solid";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { FileKind } from "@/libs/application/files/library-query";
import { t } from "@/i18n";

export function FileFilters(props: {
  sharing?: "all" | "shared" | "private";
  onSharing?(value: "all" | "shared" | "private"): void;
  search: string;
  onSearch(value: string): void;
  kind: FileKind;
  onKind(value: FileKind): void;
  status?: "all" | "complete" | "incomplete";
  onStatus(value: "all" | "complete" | "incomplete"): void;
  sort: "recent" | "name" | "size";
  onSort(value: "recent" | "name" | "size"): void;
}) {
  return (
    <div class="flex shrink-0 flex-col gap-3">
      <div class="flex flex-wrap gap-2">
        <div class="relative min-w-40 flex-1">
          <Search
            class="text-muted-foreground pointer-events-none absolute top-2.5
              left-3 size-4"
          />
          <Input
            class="pl-9"
            value={props.search}
            onInput={(event) =>
              props.onSearch(event.currentTarget.value)
            }
            placeholder={t("file_library.search")}
            aria-label={t("file_library.search")}
          />
        </div>
        <Show when={props.sharing}>
          <Select
            options={["all", "shared", "private"] as const}
            value={props.sharing}
            onChange={(value) =>
              value && props.onSharing?.(value)
            }
            itemComponent={(item) => (
              <SelectItem item={item.item}>
                {t(
                  `shared_files.filter_${item.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger
              class="w-32"
              aria-label={t("shared_files.filter")}
            >
              <SelectValue<string>>
                {(state) =>
                  t(
                    `shared_files.filter_${state.selectedOption()}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Show>
        <Show when={props.status}>
          <Select
            options={
              ["all", "complete", "incomplete"] as const
            }
            value={props.status}
            onChange={(value) =>
              value && props.onStatus(value)
            }
            itemComponent={(item) => (
              <SelectItem item={item.item}>
                {t(
                  `file_library.status_${item.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger
              class="w-32"
              aria-label={t("file_library.status")}
            >
              <SelectValue<string>>
                {(state) =>
                  t(
                    `file_library.status_${state.selectedOption() as typeof props.status}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </Show>
        <Select
          options={["recent", "name", "size"] as const}
          value={props.sort}
          onChange={(value) => value && props.onSort(value)}
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {t(`file_library.sort_${item.item.rawValue}`)}
            </SelectItem>
          )}
        >
          <SelectTrigger
            class="w-32"
            aria-label={t("file_library.sort")}
          >
            <SelectValue<string>>
              {(state) =>
                t(
                  `file_library.sort_${state.selectedOption() as typeof props.sort}`,
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div
        class="flex gap-1 overflow-x-auto pb-1"
        role="group"
        aria-label={t("file_library.type")}
      >
        <For
          each={
            [
              "all",
              "image",
              "video",
              "audio",
              "document",
              "other",
            ] as FileKind[]
          }
        >
          {(kind) => (
            <Button
              size="sm"
              variant={
                props.kind === kind ? "secondary" : "ghost"
              }
              class="h-8 shrink-0 rounded-full"
              aria-pressed={props.kind === kind}
              onClick={() => props.onKind(kind)}
            >
              {t(`file_library.type_${kind}`)}
            </Button>
          )}
        </For>
      </div>
    </div>
  );
}
