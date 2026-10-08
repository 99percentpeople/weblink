import { For, Show } from "solid-js";
import {
  Check,
  History,
  LockKeyhole,
  Plus,
  Trash2,
} from "lucide-solid";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { resolvedLocale } from "@/libs/state/app-locale";
import type { RoomConversation } from "@/libs/domain/conversation";

export function RoomJoinHistoryList(props: {
  rooms: readonly RoomConversation[];
  selected: string | null;
  onSelect(roomId: string): void;
  onDelete(roomId: string): void;
  onAdd(): void;
}) {
  return (
    <div class="flex min-h-0 flex-col gap-2">
      <div class="flex items-center justify-between gap-2">
        <h3
          class="text-muted-foreground flex items-center gap-1.5 text-xs
            font-medium"
        >
          <History class="size-3.5" />
          {t("common.join_form.history.title")}
        </h3>
        <Button
          type="button"
          variant="outline"
          size="sm"
          class="h-7 gap-1 px-2 text-xs"
          onClick={props.onAdd}
        >
          <Plus class="size-3.5" />
          {t("common.join_form.history.add")}
        </Button>
      </div>
      <ul
        class="border-border divide-border max-h-64 divide-y
          overflow-y-auto overscroll-contain rounded-lg border"
        aria-label={t("common.join_form.history.title")}
      >
        <For each={props.rooms}>
          {(room) => (
            <li
              class="flex min-w-0 items-center pr-1 transition-colors"
              classList={{
                "bg-primary/8":
                  props.selected === room.roomId,
                "hover:bg-muted/50":
                  props.selected !== room.roomId,
              }}
            >
              <button
                type="button"
                class="focus-visible:ring-ring flex min-w-0 flex-1 items-center
                  gap-2 px-2.5 py-2 text-left outline-none
                  focus-visible:ring-2 focus-visible:ring-inset"
                aria-label={room.roomId}
                aria-pressed={
                  props.selected === room.roomId
                }
                onClick={() => props.onSelect(room.roomId)}
              >
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-sm font-medium leading-5">
                    <span
                      class="truncate"
                      title={room.roomId}
                    >
                      {room.title || room.roomId}
                    </span>
                    <Show when={room.joinPassword}>
                      <LockKeyhole
                        class="text-muted-foreground size-3.5 shrink-0"
                        aria-label={t(
                          "common.join_form.history.protected",
                        )}
                      />
                    </Show>
                  </span>
                  <span class="text-muted-foreground block truncate text-[11px] leading-4">
                    {t(
                      "common.join_form.history.last_joined",
                      {
                        time: new Date(
                          room.lastJoinedAt ??
                            room.createdAt,
                        ).toLocaleString(resolvedLocale(), {
                          year: "numeric",
                          month: "2-digit",
                          day: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        }),
                      },
                    )}
                  </span>
                </span>
                <span
                  class="size-4 shrink-0"
                  aria-hidden="true"
                >
                  <Show
                    when={props.selected === room.roomId}
                  >
                    <Check class="text-primary size-4" />
                  </Show>
                </span>
              </button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                class="text-muted-foreground hover:text-destructive size-8"
                aria-label={t(
                  "common.join_form.history.remove",
                  { room: room.roomId },
                )}
                title={t(
                  "common.join_form.history.remove",
                  { room: room.roomId },
                )}
                onClick={() => props.onDelete(room.roomId)}
              >
                <Trash2 class="size-3.5" />
              </Button>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
