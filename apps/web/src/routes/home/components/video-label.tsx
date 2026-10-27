import { Show } from "solid-js";
import { Monitor } from "lucide-solid";
import { Badge } from "@/components/ui/badge";
import { ControlIndicatorIcon } from "@/components/common/control-indicator";
import {
  IconRecord,
  IconPause,
  IconVolumeUpFilled,
} from "@/components/icons";
import { t } from "@/i18n";

export interface VideoLabelProps {
  name: string;
  screen?: string;
  controller?: string;
  automation?: boolean;
  speaking?: boolean;
  recording?: boolean;
  recordingPaused?: boolean;
}

export function VideoLabel(props: VideoLabelProps) {
  const recordingLabel = () =>
    t(
      props.recordingPaused
        ? "recording.paused"
        : "recording.recording",
    );
  const controller = () =>
    props.controller
      ? t(
          props.automation
            ? "remote_control.automation_controlled_by"
            : "remote_control.controlled_by",
          {
            name: props.controller,
          },
        )
      : t(
          props.automation
            ? "remote_control.automation_host_active_short"
            : "remote_control.host_active_short",
        );
  return (
    <Badge
      variant="secondary"
      title={props.name}
      class="pointer-events-auto min-w-0 max-w-full gap-1 bg-black/50
        text-xs text-white hover:bg-black/80"
    >
      <Show when={props.screen}>
        {(screen) => (
          <span
            role="img"
            aria-label={screen()}
            title={screen()}
            class="shrink-0"
          >
            <Monitor class="size-4" aria-hidden="true" />
          </span>
        )}
      </Show>
      <span class="truncate">{props.name}</span>
      <Show when={props.recording}>
        <span
          role="img"
          aria-label={recordingLabel()}
          title={recordingLabel()}
          class="shrink-0"
        >
          <Show
            when={props.recordingPaused}
            fallback={
              <IconRecord
                class="size-4"
                aria-hidden="true"
              />
            }
          >
            <IconPause class="size-4" aria-hidden="true" />
          </Show>
        </span>
      </Show>
      <Show when={props.controller || props.automation}>
        <span
          role="img"
          aria-label={controller()}
          title={controller()}
          class="shrink-0"
        >
          <ControlIndicatorIcon
            automation={props.automation}
            class="size-4"
          />
        </span>
      </Show>
      <Show when={props.speaking}>
        <IconVolumeUpFilled class="size-4 shrink-0" />
      </Show>
    </Badge>
  );
}
