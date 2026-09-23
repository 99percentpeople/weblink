import { Show } from "solid-js";
import { MonitorUp, Volume2, VolumeX } from "lucide-solid";
import { ClientAvatar } from "@/components/common/client-avatar";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { t } from "@/i18n";

export function MeetingSharingStatus(props: {
  name: string;
  avatar?: string;
  count: number;
  onStop(): void;
  audioAvailable: boolean;
  audioOn: boolean;
  onAudioChange(enabled: boolean): void;
  busy?: boolean;
}) {
  const presenter = () =>
    t("meeting.sharing_presenter", { name: props.name });

  return (
    <div
      class="meeting-sharing-status bg-card flex max-w-[560px] min-w-0
        shrink items-center gap-[7px] rounded-full border py-[5px]
        pr-1.5 pl-2.5 text-[12px] max-md:gap-[5px] max-md:py-1
        max-md:pr-[5px] max-md:pl-2 max-md:text-[11px]"
      data-sharing-count={props.count}
    >
      <MonitorUp
        class="text-primary size-4 shrink-0"
        aria-hidden="true"
      />
      <ClientAvatar
        class="size-6 shrink-0 text-[10px] max-md:hidden"
        name={props.name}
        avatar={props.avatar}
      />
      <span
        class="meeting-sharing-presenter min-w-0 truncate font-medium"
        title={presenter()}
        role="status"
      >
        {presenter()}
      </span>
      <Show when={props.count > 1}>
        <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          ×{props.count}
        </span>
      </Show>
      <span
        class="bg-input h-[18px] w-px shrink-0"
        aria-hidden="true"
      />
      <Switch
        class="flex shrink-0 items-center gap-1.5 px-1"
        checked={props.audioOn}
        disabled={props.busy || !props.audioAvailable}
        onChange={props.onAudioChange}
        title={
          !props.audioAvailable
            ? t("meeting.sharing_audio_unavailable")
            : props.audioOn
              ? t("meeting.mute_sharing_audio")
              : t("meeting.enable_sharing_audio")
        }
      >
        <SwitchLabel class="flex cursor-pointer items-center">
          <Show
            when={props.audioOn}
            fallback={
              <VolumeX class="size-4" aria-hidden="true" />
            }
          >
            <Volume2 class="size-4" aria-hidden="true" />
          </Show>
          <span class="sr-only">
            {t("meeting.sharing_audio")}
          </span>
        </SwitchLabel>
        <SwitchControl class="h-5 w-9 bg-[#ffffff26] data-[checked]:bg-[#365889]">
          <SwitchThumb class="size-4 bg-[#d4e3ff] data-[checked]:translate-x-4" />
        </SwitchControl>
      </Switch>
      <button
        type="button"
        class="bg-accent text-accent-foreground hover:bg-secondary shrink-0
          rounded-full px-2.5 py-1.5 text-[11px] leading-4
          whitespace-nowrap max-md:px-2 max-md:py-[5px]"
        aria-label={t("meeting.stop_sharing")}
        title={t("meeting.stop_sharing")}
        disabled={props.busy}
        onClick={props.onStop}
      >
        <span class="max-md:hidden">
          {t("meeting.stop_sharing")}
        </span>
        <span class="hidden max-md:inline">
          {t("meeting.stop_sharing_short")}
        </span>
      </button>
    </div>
  );
}
