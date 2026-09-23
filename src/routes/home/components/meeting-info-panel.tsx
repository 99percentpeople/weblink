import { Show } from "solid-js";
import {
  ChevronRight,
  HardDrive,
  MessageSquare,
  Settings,
  Users,
} from "lucide-solid";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export function MeetingInfoPanel(props: {
  roomId?: string | null;
  active: boolean;
  onOpenSettings(): void;
  onOpenChat(): void;
}) {
  return (
    <div
      class="flex min-h-0 min-w-0 flex-col gap-5 overflow-auto
        overscroll-contain p-5 text-[13px]"
    >
      <header class="flex items-center gap-3">
        <span
          class="bg-accent text-accent-foreground grid size-11 shrink-0
            place-items-center rounded-md"
          aria-hidden="true"
        >
          <Users class="size-[22px]" />
        </span>
        <div class="min-w-0">
          <h2 class="text-[15px] font-semibold">
            {t("meeting.room_info")}
          </h2>
          <span
            class="text-muted-foreground data-[active]:text-primary mt-1
              inline-flex items-center gap-1.5 text-[11px] before:size-1.5
              before:rounded-full before:bg-current before:content-['']"
            data-active={props.active ? "" : undefined}
          >
            {t(
              props.active
                ? "meeting.in_room"
                : "meeting.preview",
            )}
          </span>
        </div>
      </header>

      <dl class="bg-muted/55 flex min-w-0 flex-col gap-[18px] rounded-md p-4">
        <div>
          <dt class="text-muted-foreground mb-1.5 text-[11px]">
            {t("meeting.room_name")}
          </dt>
          <dd class="leading-[1.6] [overflow-wrap:anywhere]">
            {props.roomId || t("meeting.not_joined")}
          </dd>
        </div>
        <div>
          <dt class="text-muted-foreground mb-1.5 text-[11px]">
            {t("meeting.message_history")}
          </dt>
          <dd
            class="flex items-center gap-2 leading-[1.6]
              [overflow-wrap:anywhere]"
          >
            <HardDrive
              class="text-muted-foreground size-[15px] shrink-0"
              aria-hidden="true"
            />
            {t("meeting.local_history")}
          </dd>
        </div>
      </dl>

      <div
        class="text-muted-foreground flex flex-col gap-2.5 text-xs
          leading-[1.7]"
      >
        <p>{t("meeting.history_hint")}</p>
        <p>{t("meeting.leave_hint")}</p>
      </div>

      <div class="flex flex-col gap-2.5 border-t pt-4">
        <Button
          type="button"
          variant="outline"
          class="meeting-info-action"
          onClick={props.onOpenSettings}
        >
          <Settings aria-hidden="true" />
          <span>{t("room_dialog.open")}</span>
          <ChevronRight
            class="text-muted-foreground"
            aria-hidden="true"
          />
        </Button>
        <Show when={props.active}>
          <Button
            type="button"
            variant="secondary"
            class="meeting-info-action"
            onClick={props.onOpenChat}
          >
            <MessageSquare aria-hidden="true" />
            <span>{t("meeting.open_room_chat")}</span>
            <ChevronRight
              class="text-muted-foreground"
              aria-hidden="true"
            />
          </Button>
        </Show>
      </div>
    </div>
  );
}
