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
      class="meeting-sharing-status"
      data-sharing-count={props.count}
    >
      <MonitorUp
        class="meeting-sharing-icon"
        aria-hidden="true"
      />
      <ClientAvatar
        class="meeting-sharing-avatar size-6 text-[10px]"
        name={props.name}
        avatar={props.avatar}
      />
      <span
        class="meeting-sharing-presenter"
        title={presenter()}
        role="status"
      >
        {presenter()}
      </span>
      <Show when={props.count > 1}>
        <span class="meeting-sharing-count">
          ×{props.count}
        </span>
      </Show>
      <span
        class="meeting-sharing-divider"
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
        class="meeting-sharing-stop"
        aria-label={t("meeting.stop_sharing")}
        title={t("meeting.stop_sharing")}
        disabled={props.busy}
        onClick={props.onStop}
      >
        <span class="meeting-sharing-stop-full">
          {t("meeting.stop_sharing")}
        </span>
        <span class="meeting-sharing-stop-short">
          {t("meeting.stop_sharing_short")}
        </span>
      </button>
    </div>
  );
}
