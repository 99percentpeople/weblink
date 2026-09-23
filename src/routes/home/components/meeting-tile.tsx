import { Motion } from "@/components/ui/motion";
import { createEffect, createSignal, Show } from "solid-js";
import {
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  Volume2,
  VolumeX,
  X,
} from "lucide-solid";
import { t } from "@/i18n";
import { createFullscreen } from "@/libs/hooks/fullscreen";
import {
  useVideoDisplay,
  VideoDisplay,
} from "./video-display";

export function MeetingTile(props: {
  compact?: boolean;
  onSelect?: () => void;
  sourceId?: string;
  order?: number;
  sourceKind?: string;
  trackId?: string;
  name: string;
  avatar?: string;
  stream?: MediaStream | null;
  placeholder?: boolean;
  local?: boolean;
  pinned: boolean;
  onPin(): void;
  onStop?: () => void;
}) {
  return (
    <Motion.article
      class="meeting-tile"
      style={{ order: props.order }}
      classList={{ "is-featured": props.pinned }}
      aria-label={props.name}
      data-source-id={props.sourceId}
      layout
      layoutId={
        props.sourceId
          ? `meeting-source:${props.sourceId}`
          : undefined
      }
      data-source-kind={props.sourceKind}
      data-source-local={props.local === true}
      data-track-id={props.trackId}
    >
      <VideoDisplay
        class="meeting-tile-video"
        stream={props.stream}
        name={props.name}
        avatar={props.avatar}
        isPlaceholderStream={props.placeholder}
        muted
      >
        <Show when={props.onSelect}>
          <button
            type="button"
            class="meeting-tile-select"
            aria-label={t("meeting.feature_source", {
              name: props.name,
            })}
            title={t("meeting.feature_source", {
              name: props.name,
            })}
            onClick={() => props.onSelect?.()}
          />
        </Show>
        <Show when={!props.compact}>
          <TileActions
            local={props.local}
            pinned={props.pinned}
            onPin={props.onPin}
            onStop={props.onStop}
            name={props.name}
          />
        </Show>
      </VideoDisplay>
    </Motion.article>
  );
}

function TileActions(props: {
  local?: boolean;
  pinned: boolean;
  onPin(): void;
  onStop?: () => void;
  name: string;
}) {
  const { videoRef, audioTracks } = useVideoDisplay();
  const [muted, setMuted] = createSignal(false);
  const fullscreen = createFullscreen(videoRef);
  createEffect(() => {
    if (props.local) return;
    const tracks = audioTracks();
    setMuted(
      tracks.length > 0 &&
        tracks.every((track) => !track.enabled),
    );
  });
  return (
    <div class="meeting-tile-actions">
      <Show when={props.onStop}>
        <button
          type="button"
          class="meeting-icon-button"
          aria-label={t("meeting.stop_source", {
            name: props.name,
          })}
          title={t("meeting.stop_source", {
            name: props.name,
          })}
          onClick={() => props.onStop?.()}
        >
          <X />
        </button>
      </Show>
      <Show when={!props.local && audioTracks().length}>
        <button
          type="button"
          class="meeting-icon-button"
          aria-pressed={muted()}
          aria-label={
            muted()
              ? t("common.action.unmute")
              : t("common.action.mute")
          }
          title={
            muted()
              ? t("common.action.unmute")
              : t("common.action.mute")
          }
          onClick={() => {
            const next = !muted();
            audioTracks().forEach((track) => {
              track.enabled = !next;
            });
            setMuted(next);
          }}
        >
          <Show when={muted()} fallback={<Volume2 />}>
            <VolumeX />
          </Show>
        </button>
      </Show>
      <Show when={videoRef() && fullscreen.isSupported()}>
        <button
          type="button"
          class="meeting-icon-button"
          aria-label={
            fullscreen.isThisElementFullscreen()
              ? t("common.action.exit_fullscreen")
              : t("common.action.fullscreen")
          }
          title={t("common.action.fullscreen")}
          onClick={() =>
            void (fullscreen.isThisElementFullscreen()
              ? fullscreen.exitFullscreen()
              : fullscreen.requestFullscreen())
          }
        >
          <Show
            when={fullscreen.isThisElementFullscreen()}
            fallback={<Maximize2 />}
          >
            <Minimize2 />
          </Show>
        </button>
      </Show>
      <button
        type="button"
        class="meeting-icon-button"
        aria-pressed={props.pinned}
        aria-label={
          props.pinned
            ? t("meeting.unpin")
            : t("meeting.pin")
        }
        title={
          props.pinned
            ? t("meeting.unpin")
            : t("meeting.pin")
        }
        onClick={props.onPin}
      >
        <Show when={props.pinned} fallback={<Pin />}>
          <PinOff />
        </Show>
      </button>
    </div>
  );
}
