import { Match, Show, Switch } from "solid-js";
import { LoaderCircle, X } from "lucide-solid";
import {
  IconPause,
  IconPlayArrow,
  IconRecord,
  IconStop,
} from "@/components/icons";
import { ClientAvatar } from "@/components/common/client-avatar";
import { t } from "@/i18n";
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import type { RecordingStatus } from "@/libs/state/create-recording";

export function MeetingRecordingStatus(props: {
  state: RecordingStatus;
  onPause(): void;
  onResume(): void;
  onStop(): void;
}) {
  const label = () => t(`recording.${props.state.phase}`);
  const participantName = () =>
    props.state.participantName ?? props.state.name;
  const elapsed = () => {
    const seconds = Math.floor(props.state.elapsed / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  };
  const action = () =>
    props.state.phase === "preparing"
      ? t("common.action.cancel")
      : t("recording.stop");
  const paused = () => props.state.phase === "paused";
  const pauseAction = () =>
    t(paused() ? "recording.resume" : "recording.pause");
  return (
    <div
      class="meeting-status-pill max-w-[440px]"
      title={`${label()} · ${props.state.name}`}
    >
      <Switch
        fallback={
          <LoaderCircle
            class="size-4 shrink-0 animate-spin"
            aria-hidden="true"
          />
        }
      >
        <Match when={props.state.phase === "recording"}>
          <IconRecord
            class="size-4 shrink-0"
            aria-hidden="true"
          />
        </Match>
        <Match when={paused()}>
          <IconPause
            class="size-4 shrink-0"
            aria-hidden="true"
          />
        </Match>
      </Switch>
      <div
        role="status"
        class="flex min-w-0 items-center gap-1.5"
        title={`${label()} · ${props.state.name}`}
      >
        <span class="sr-only">{label()}</span>
        <ClientAvatar
          class="size-6 shrink-0 text-[10px]"
          name={participantName()}
          avatar={props.state.avatar}
          role="img"
          aria-label={participantName()}
          title={participantName()}
        />
        <span class="min-w-0 truncate font-medium">
          {props.state.sourceLabel || props.state.name}
        </span>
      </div>
      <span class="shrink-0 tabular-nums">{elapsed()}</span>
      <span class="text-muted-foreground shrink-0 tabular-nums max-sm:hidden">
        {formatBtyeSize(props.state.bytes)}
      </span>
      <Show when={props.state.phase !== "saving"}>
        <span
          class="meeting-status-divider"
          aria-hidden="true"
        />
        <Show
          when={
            props.state.phase === "recording" || paused()
          }
        >
          <button
            type="button"
            class="meeting-status-action"
            title={pauseAction()}
            aria-label={pauseAction()}
            onClick={() =>
              paused() ? props.onResume() : props.onPause()
            }
          >
            <Show
              when={paused()}
              fallback={
                <IconPause
                  class="size-4 shrink-0"
                  aria-hidden="true"
                />
              }
            >
              <IconPlayArrow
                class="size-4 shrink-0"
                aria-hidden="true"
              />
            </Show>
          </button>
        </Show>
        <button
          type="button"
          class="meeting-status-action"
          title={action()}
          aria-label={action()}
          onClick={props.onStop}
        >
          <Show
            when={props.state.phase === "preparing"}
            fallback={
              <IconStop
                class="size-4 shrink-0"
                aria-hidden="true"
              />
            }
          >
            <X class="size-4 shrink-0" aria-hidden="true" />
          </Show>
        </button>
      </Show>
    </div>
  );
}
