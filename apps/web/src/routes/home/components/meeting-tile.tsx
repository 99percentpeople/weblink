import {
  createVideoRemoteControl,
  createControlState,
  RemoteControlAction,
} from "./remote-control-action";
import { RemoteControlOverlay } from "./remote-control-overlay";
import {
  RemoteKeyboardInput,
  type RemoteKeyboardInputHandle,
  type RegisterRemoteKeyboardInput,
} from "./remote-keyboard-input";
import type { MeetingPipControls } from "./meeting-controls";
import type {
  RegisterMeetingMainFeatures,
  MeetingMainFeatures,
} from "./meeting-main-view";
import {
  MeetingTileAction,
  MeetingTileActions,
} from "./meeting-tile-actions";
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
  Activity,
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
import { VideoStatisticsOverlay } from "./video-statistics-overlay";
import { sessionService } from "@/libs/application/session-service";
import { useVideoDisplay } from "@/routes/home/components/video-display-context";
import { VideoDisplay } from "./video-display";

export function MeetingTile(props: {
  ref?: (element: HTMLElement) => void;
  compact?: boolean;
  playbackActive?: boolean;
  layoutVisible?: boolean;
  exitRect?: DOMRect;
  onSelect?: () => void;
  sourceId?: string;
  order?: number;
  sourceKind?: string;
  clientId?: string;
  trackId?: string;
  mediaError?: "codec" | "connection";
  name: string;
  avatar?: string;
  stream?: MediaStream | null;
  placeholder?: boolean;
  local?: boolean;
  audioMuted?: boolean;
  onToggleAudio?: () => void;
  pinned: boolean;
  onPin?(): void;
  onActivate?(action: () => void): void;
  registerFeatures?: RegisterMeetingMainFeatures;
  desktopPip?: MeetingPipControls;
  onStop?: () => void;
}) {
  const [displayRef, setDisplayRef] =
    createSignal<HTMLDivElement>();
  const [keyboardInput, setKeyboardInput] =
    createSignal<RemoteKeyboardInputHandle>();
  const registerKeyboard: RegisterRemoteKeyboardInput = (
    keyboard,
  ) => {
    setKeyboardInput(keyboard);
    return () => {
      if (keyboardInput() === keyboard)
        setKeyboardInput(undefined);
    };
  };
  // Fullscreen the display container so its cover and controls remain usable.
  const fullscreen = createFullscreen(displayRef);
  // IME can collapse the grid even outside fullscreen. Keep its focused editor
  // and playback alive through that resize, while still honoring source removal.
  const playbackActive = () =>
    props.playbackActive !== false &&
    (fullscreen.isThisElementFullscreen() ||
      props.layoutVisible !== false ||
      keyboardInput()?.focused() === true);
  const [previewRevealed, setPreviewRevealed] =
    createSignal(false);
  const [statisticsVisible, setStatisticsVisible] =
    createSignal(false);
  createEffect(
    on(
      () => [props.sourceId, props.trackId],
      () => {
        setPreviewRevealed(false);
        setStatisticsVisible(false);
      },
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
      ref={props.ref}
      class="meeting-tile"
      style={
        props.exitRect
          ? {
              position: "fixed",
              left: `${props.exitRect.left}px`,
              top: `${props.exitRect.top}px`,
              width: `${props.exitRect.width}px`,
              height: `${props.exitRect.height}px`,
              "z-index": 50,
              "pointer-events": "none",
            }
          : { order: props.order }
      }
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
      {/* Keep presence opacity separate from the outer layout animation. */}
      <Motion.div
        native
        class="meeting-tile-surface"
        initial={false}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
      >
        <VideoDisplay
          ref={setDisplayRef}
          class="meeting-tile-video"
          stream={props.stream}
          mediaError={props.mediaError}
          onDecodeError={(track) =>
            sessionService.reportNativeDecodeFailure(track)
          }
          name={props.name}
          avatar={props.avatar}
          isPlaceholderStream={props.placeholder}
          playbackActive={playbackActive()}
          muted
        >
          <RemoteControlOverlay
            keyboard={keyboardInput}
            enabled={
              props.pinned &&
              !props.local &&
              !props.compact &&
              playbackActive()
            }
          />
          <Show
            when={statisticsVisible() && playbackActive()}
          >
            <VideoStatisticsOverlay
              local={props.local}
              read={(track) =>
                sessionService.getVideoStats(track)
              }
            />
          </Show>
          <Show when={props.onSelect}>
            <button
              type="button"
              class="meeting-tile-select meeting-tile-focus-target"
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
              class="meeting-tile-focus-target absolute inset-0 flex flex-col
                items-center justify-center gap-3 bg-black/80 p-4
                text-center text-white"
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
              container={displayRef()}
              sourceId={props.sourceId}
              clientId={
                props.sourceKind !== "screen"
                  ? props.clientId
                  : undefined
              }
              fullscreen={fullscreen}
              local={props.local}
              playbackActive={playbackActive()}
              audioMuted={props.audioMuted}
              onToggleAudio={props.onToggleAudio}
              statisticsVisible={statisticsVisible()}
              onToggleStatistics={() =>
                setStatisticsVisible((visible) => !visible)
              }
              pinned={props.pinned}
              onPin={props.onPin}
              onActivate={props.onActivate}
              desktopPip={props.desktopPip}
              registerFeatures={props.registerFeatures}
              registerKeyboard={registerKeyboard}
              onStop={props.onStop}
              name={props.name}
            />
          </Show>
        </VideoDisplay>
      </Motion.div>
    </Motion.article>
  );
}

function TileActions(props: {
  container?: HTMLElement;
  sourceId?: string;
  clientId?: string;
  fullscreen: ReturnType<typeof createFullscreen>;
  local?: boolean;
  playbackActive?: boolean;
  audioMuted?: boolean;
  onToggleAudio?: () => void;
  statisticsVisible: boolean;
  onToggleStatistics(): void;
  registerKeyboard: RegisterRemoteKeyboardInput;
  pinned: boolean;
  onPin?(): void;
  onActivate?(action: () => void): void;
  registerFeatures?: RegisterMeetingMainFeatures;
  desktopPip?: MeetingPipControls;
  onStop?: () => void;
  name: string;
}) {
  const { videoRef, videoTrack, audioTracks } =
    useVideoDisplay();
  const videoControl = createVideoRemoteControl();
  const remote = createControlState(
    () =>
      videoControl.control() ??
      (props.clientId
        ? sessionService.getScreenControl(props.clientId)
        : undefined),
  );
  const showControl = () =>
    !props.local &&
    remote.control() &&
    (videoControl.control() ||
      remote.state() !== "unavailable");
  const muted = () => props.audioMuted === true;
  const fullscreen = props.fullscreen;
  createFullscreenVideoOrientation(
    fullscreen.isThisElementFullscreen,
    videoRef,
  );
  const isMobile = createIsMobile();
  const videoPip = createPictureInPicture(videoRef, {
    onError: reportMeetingPipError,
  });
  const pip = {
    isSupported: () =>
      props.desktopPip
        ? !!videoRef()
        : videoPip.isSupported(),
    isReady: () =>
      props.desktopPip ? !!videoRef() : videoPip.isReady(),
    isBusy: () =>
      props.desktopPip?.busy() ?? videoPip.isBusy(),
    isThisElementInPip: () =>
      props.desktopPip
        ? props.pinned && props.desktopPip.active()
        : videoPip.isThisElementInPip(),
    requestPictureInPicture: () => {
      if (!props.desktopPip)
        return videoPip.requestPictureInPicture();
      return fullscreen.exitFullscreen().then(() => {
        if (
          props.pinned &&
          props.container?.isConnected &&
          !fullscreen.isThisElementFullscreen() &&
          !props.desktopPip?.active()
        )
          props.desktopPip?.toggle();
      });
    },
    exitPictureInPicture: () => {
      if (!props.desktopPip)
        return videoPip.exitPictureInPicture();
      if (props.pinned && props.desktopPip.active())
        props.desktopPip.toggle();
      return Promise.resolve();
    },
  };
  const showPip = () =>
    (props.desktopPip || isMobile()) && pip.isSupported();
  const showStatisticsAction = () =>
    props.pinned && Boolean(videoTrack());

  const hasActions = createMemo(
    () =>
      Boolean(showControl()) ||
      Boolean(props.onStop) ||
      Boolean(
        !props.local &&
        audioTracks().length &&
        props.onToggleAudio,
      ) ||
      Boolean(showPip()) ||
      showStatisticsAction() ||
      Boolean(videoRef() && fullscreen.isSupported()) ||
      Boolean(props.onPin),
  );
  const activate = (action: () => void) => {
    const run = () => {
      if (props.pinned && props.container?.isConnected)
        action();
    };
    if (props.onActivate) props.onActivate(run);
    else run();
  };
  const controlInUse = () =>
    !props.local &&
    (remote.state() === "requesting" ||
      remote.state() === "activating" ||
      remote.state() === "active");
  const features: MeetingMainFeatures = {
    active: () =>
      controlInUse() ||
      fullscreen.isThisElementFullscreen() ||
      fullscreen.isBusy() ||
      videoPip.isThisElementInPip() ||
      videoPip.isBusy(),
    stop: async () => {
      if (controlInUse()) remote.control()?.cancel();
      await Promise.all([
        fullscreen.exitFullscreen(),
        // Native window PiP belongs to the meeting's shared presentation owner.
        videoPip.exitPictureInPicture(),
      ]);
      return (
        !fullscreen.isThisElementFullscreen() &&
        !videoPip.isThisElementInPip()
      );
    },
  };
  createEffect(() => {
    const id = props.sourceId;
    if (!id || !props.registerFeatures) return;
    const unregister = props.registerFeatures(id, features);
    onCleanup(unregister);
  });
  createEffect(
    on(
      () => props.pinned,
      (main) => {
        if (main) return;
        // Also release presentation on an automatic avatar-to-screen handoff.
        // Its control belongs to the approved screen and must not be cancelled.
        void fullscreen.exitFullscreen();
        void videoPip.exitPictureInPicture();
      },
    ),
  );
  onCleanup(() => {
    if (props.pinned && controlInUse())
      remote.control()?.cancel();
  });
  return (
    <>
      <Show
        when={!props.desktopPip && pip.isThisElementInPip()}
      >
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
      <Show when={hasActions()}>
        <MeetingTileActions
          compact={isMobile()}
          label={t("meeting.source_actions", {
            name: props.name,
          })}
          portalMount={
            fullscreen.isThisElementFullscreen()
              ? props.container
              : undefined
          }
        >
          <Show
            when={
              props.pinned &&
              !props.local &&
              videoControl.control()
            }
          >
            {(control) => (
              <RemoteKeyboardInput
                control={control()}
                state={videoControl.state()}
                enabled={props.playbackActive !== false}
                registerKeyboard={props.registerKeyboard}
              />
            )}
          </Show>
          <Show when={showControl() && remote.control()}>
            {(control) => (
              <RemoteControlAction
                control={control()}
                state={remote.state()}
                onRequest={
                  videoControl.control()
                    ? activate
                    : undefined
                }
              />
            )}
          </Show>
          <Show when={props.onStop}>
            <MeetingTileAction
              label={t("meeting.stop_source", {
                name: props.name,
              })}
              onAction={() => props.onStop?.()}
            >
              <X />
            </MeetingTileAction>
          </Show>
          <Show
            when={
              !props.local &&
              audioTracks().length &&
              props.onToggleAudio
            }
          >
            <MeetingTileAction
              active={muted()}
              label={
                muted()
                  ? t("common.action.unmute")
                  : t("common.action.mute")
              }
              onAction={() => props.onToggleAudio?.()}
            >
              <Show when={muted()} fallback={<Volume2 />}>
                <VolumeX />
              </Show>
            </MeetingTileAction>
          </Show>
          <Show when={showPip()}>
            <MeetingTileAction
              label={t(
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
              active={pip.isThisElementInPip()}
              disabled={
                !pip.isThisElementInPip() &&
                (pip.isBusy() || !pip.isReady())
              }
              onAction={() =>
                pip.isThisElementInPip()
                  ? void pip.exitPictureInPicture()
                  : activate(
                      () =>
                        void pip.requestPictureInPicture(),
                    )
              }
            >
              <PictureInPicture2 />
            </MeetingTileAction>
          </Show>
          <Show
            when={videoRef() && fullscreen.isSupported()}
          >
            <MeetingTileAction
              label={
                fullscreen.isThisElementFullscreen()
                  ? t("common.action.exit_fullscreen")
                  : t("common.action.fullscreen")
              }
              title={t("common.action.fullscreen")}
              disabled={
                pip.isThisElementInPip() ||
                fullscreen.isBusy()
              }
              onAction={() =>
                fullscreen.isThisElementFullscreen()
                  ? void fullscreen.exitFullscreen()
                  : activate(
                      () =>
                        void fullscreen.requestFullscreen(),
                    )
              }
            >
              <Show
                when={fullscreen.isThisElementFullscreen()}
                fallback={<Maximize2 />}
              >
                <Minimize2 />
              </Show>
            </MeetingTileAction>
          </Show>
          <Show when={showStatisticsAction()}>
            <MeetingTileAction
              active={props.statisticsVisible}
              label={t(
                props.statisticsVisible
                  ? "video.statistics.hide_overlay"
                  : "video.statistics.show_overlay",
              )}
              onAction={props.onToggleStatistics}
            >
              <Activity />
            </MeetingTileAction>
          </Show>
          <Show when={props.onPin}>
            <MeetingTileAction
              active={props.pinned}
              label={
                props.pinned
                  ? t("meeting.unpin")
                  : t("meeting.pin")
              }
              onAction={() => props.onPin?.()}
            >
              <Show when={props.pinned} fallback={<Pin />}>
                <PinOff />
              </Show>
            </MeetingTileAction>
          </Show>
        </MeetingTileActions>
      </Show>
    </>
  );
}
