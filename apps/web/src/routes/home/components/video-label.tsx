import { Show } from "solid-js";
import { Monitor, MousePointer2 } from "lucide-solid";
import { Badge } from "@/components/ui/badge";
import { IconVolumeUpFilled } from "@/components/icons";
import { t } from "@/i18n";

export interface VideoLabelProps {
  name: string;
  screen?: string;
  controller?: string;
  speaking?: boolean;
}

export function VideoLabel(props: VideoLabelProps) {
  const controller = () =>
    t("remote_control.controlled_by", {
      name: props.controller ?? "",
    });
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
      <Show when={props.controller}>
        <span
          role="img"
          aria-label={controller()}
          title={controller()}
          class="shrink-0"
        >
          <MousePointer2
            class="size-4"
            aria-hidden="true"
          />
        </span>
      </Show>
      <Show when={props.speaking}>
        <IconVolumeUpFilled class="size-4 shrink-0" />
      </Show>
    </Badge>
  );
}
