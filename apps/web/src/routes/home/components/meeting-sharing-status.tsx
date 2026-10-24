import { Show } from "solid-js";
import { MonitorUp, Volume2, VolumeX } from "lucide-solid";
import { IconStop } from "@/components/icons";
import { t } from "@/i18n";
import { MeetingStatusLabel } from "./meeting-status-label";

export function MeetingSharingStatus(props: {
  name: string;
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
      class="meeting-sharing-status meeting-status-pill max-w-[560px]"
      data-sharing-count={props.count}
      title={presenter()}
    >
      <MonitorUp
        class="size-4 shrink-0"
        aria-hidden="true"
      />
      <MeetingStatusLabel
        name={props.name}
        label={presenter()}
      />
      <Show when={props.count > 1}>
        <span class="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          ×{props.count}
        </span>
      </Show>
      <span
        class="meeting-status-divider"
        aria-hidden="true"
      />
      <button
        type="button"
        role="switch"
        class="meeting-status-action"
        aria-label={t("meeting.sharing_audio")}
        aria-checked={props.audioOn}
        disabled={props.busy || !props.audioAvailable}
        onClick={() => props.onAudioChange(!props.audioOn)}
        title={
          !props.audioAvailable
            ? t("meeting.sharing_audio_unavailable")
            : props.audioOn
              ? t("meeting.mute_sharing_audio")
              : t("meeting.enable_sharing_audio")
        }
      >
        <Show
          when={props.audioOn}
          fallback={
            <VolumeX class="size-4" aria-hidden="true" />
          }
        >
          <Volume2 class="size-4" aria-hidden="true" />
        </Show>
      </button>
      <button
        type="button"
        class="meeting-status-action"
        aria-label={t("meeting.stop_sharing")}
        title={t("meeting.stop_sharing")}
        disabled={props.busy}
        onClick={props.onStop}
      >
        <IconStop class="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
