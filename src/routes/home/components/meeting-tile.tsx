import { Motion } from "@/components/ui/motion";
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
} from "solid-js";
import {
  EyeOff,
  Maximize2,
  Minimize2,
  Pin,
  PinOff,
  PictureInPicture2,
  Volume2,
  VolumeX,
  X,
} from "lucide-solid";
import { t } from "@/i18n";
import { createFullscreen } from "@/libs/hooks/fullscreen";
import { createFullscreenVideoOrientation } from "@/libs/hooks/fullscreen-video-orientation";
import { createPictureInPicture } from "@/libs/hooks/picture-in-picture";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { reportMeetingPipError } from "./meeting-pip-error";
import {
  useVideoDisplay,
  VideoDisplay,
} from "./video-display";

export function MeetingTile(props: {
  compact?: boolean;
  playbackActive?: boolean;
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
  audioMuted?: boolean;
  onToggleAudio?: () => void;
  pinned: boolean;
  onPin?(): void;
  onVideoPipEnter?(): void;
  onStop?: () => void;
}) {
  const [displayRef, setDisplayRef] =
    createSignal<HTMLDivElement>();
  // Fullscreen the display container so its cover and controls remain usable.
  const fullscreen = createFullscreen(displayRef);
  const [previewRevealed, setPreviewRevealed] =
    createSignal(false);
  createEffect(
    on(
      () => [props.sourceId, props.trackId],
      () => setPreviewRevealed(false),
    ),
  );
  const previewCovered = createMemo(
    () =>
      props.local === true &&
      props.sourceKind === "screen" &&
      (props.pinned ||
        fullscreen.isThisElementFullscreen()) &&
      !previewRevealed(),
  );
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
        ref={setDisplayRef}
        class="meeting-tile-video"
        stream={props.stream}
        name={props.name}
        avatar={props.avatar}
        isPlaceholderStream={props.placeholder}
        playbackActive={props.playbackActive}
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
        <Show when={previewCovered()}>
          <button
            type="button"
            class="absolute inset-0 flex flex-col items-center justify-center
              gap-3 bg-black/80 p-4 text-center text-white
              focus-visible:outline focus-visible:outline-2
              focus-visible:-outline-offset-4 focus-visible:outline-white"
            aria-label={t("meeting.show_screen_preview")}
            onClick={() => setPreviewRevealed(true)}
          >
            <EyeOff
              class="size-8 shrink-0"
              aria-hidden="true"
            />
            <span class="text-sm font-medium">
              {t("meeting.screen_preview_covered")}
            </span>
            <span class="text-xs text-white/75">
              {t("meeting.screen_preview_covered_hint")}
            </span>
          </button>
        </Show>
        <Show when={!props.compact}>
          <TileActions
            fullscreen={fullscreen}
            local={props.local}
            audioMuted={props.audioMuted}
            onToggleAudio={props.onToggleAudio}
            pinned={props.pinned}
            onPin={props.onPin}
            onVideoPipEnter={props.onVideoPipEnter}
            onStop={props.onStop}
            name={props.name}
          />
        </Show>
      </VideoDisplay>
    </Motion.article>
  );
}

function TileActions(props: {
  fullscreen: ReturnType<typeof createFullscreen>;
  local?: boolean;
  audioMuted?: boolean;
  onToggleAudio?: () => void;
  pinned: boolean;
  onPin?(): void;
  onVideoPipEnter?(): void;
  onStop?: () => void;
  name: string;
}) {
  const { videoRef, audioTracks } = useVideoDisplay();
  const muted = () => props.audioMuted === true;
  const fullscreen = props.fullscreen;
  createFullscreenVideoOrientation(
    fullscreen.isThisElementFullscreen,
    videoRef,
  );
  const isMobile = createIsMobile();
  const pip = createPictureInPicture(videoRef, {
    onError: reportMeetingPipError,
  });
  createEffect(
    on(
      () => isMobile() && pip.isThisElementInPip(),
      (active) => {
        if (!active) return;
        let cancelled = false;
        // Leave the reactive batch before measuring the main-view transition.
        queueMicrotask(() => {
          if (!cancelled) props.onVideoPipEnter?.();
        });
        onCleanup(() => {
          cancelled = true;
        });
      },
    ),
  );
  return (
    <>
      <Show when={pip.isThisElementInPip()}>
        <div
          class="absolute inset-0 flex flex-col items-center justify-center
            gap-3 bg-black p-4 text-center text-white"
          role="status"
        >
          <PictureInPicture2
            class="size-8 shrink-0"
            aria-hidden="true"
          />
          <span class="text-sm font-medium">
            {t("meeting.pip_video_elsewhere")}
          </span>
          <button
            type="button"
            class="rounded-md border border-white/30 px-3 py-2 text-sm
              hover:bg-white/10 focus-visible:outline
              focus-visible:outline-2 focus-visible:outline-white"
            onClick={() => void pip.exitPictureInPicture()}
          >
            {t("meeting.pip_video_restore")}
          </button>
        </div>
      </Show>
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
        <Show
          when={
            !props.local &&
            audioTracks().length &&
            props.onToggleAudio
          }
        >
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
            onClick={() => props.onToggleAudio?.()}
          >
            <Show when={muted()} fallback={<Volume2 />}>
              <VolumeX />
            </Show>
          </button>
        </Show>
        <Show when={isMobile() && pip.isSupported()}>
          <button
            type="button"
            class="meeting-icon-button"
            aria-label={t(
              pip.isThisElementInPip()
                ? "common.action.exit_picture_in_picture"
                : "common.action.picture_in_picture",
            )}
            title={t(
              !pip.isReady()
                ? "meeting.pip_video_required"
                : pip.isThisElementInPip()
                  ? "common.action.exit_picture_in_picture"
                  : "common.action.picture_in_picture",
            )}
            aria-pressed={pip.isThisElementInPip()}
            disabled={
              !pip.isThisElementInPip() &&
              (pip.isBusy() || !pip.isReady())
            }
            onClick={() =>
              void (pip.isThisElementInPip()
                ? pip.exitPictureInPicture()
                : pip.requestPictureInPicture())
            }
          >
            <PictureInPicture2 />
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
            disabled={pip.isThisElementInPip()}
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
        <Show when={props.onPin}>
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
        </Show>
      </div>
    </>
  );
}
