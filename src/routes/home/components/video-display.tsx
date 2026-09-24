import { IconVolumeUpFilled } from "@/components/icons";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/libs/cn";
import { createCheckVolume } from "@/libs/hooks/check-volume";
import {
  ParentProps,
  Accessor,
  createEffect,
  createMemo,
  Show,
  createContext,
  useContext,
  createSignal,
  onCleanup,
} from "solid-js";
import { ClientAvatar } from "../../../components/common/client-avatar";
import { createMediaTracks } from "@/libs/hooks/tracks";
import { createVideoPlaybackRecovery } from "@/libs/hooks/video-playback-recovery";
import { Spinner } from "../../../components/common/spinner";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { getVisibleVideoDisplayTracks } from "./video-display-tracks";

const VideoContext = createContext<{
  videoRef: Accessor<HTMLVideoElement | null>;
  videoTrack: Accessor<MediaStreamTrack | null>;
  audioTracks: Accessor<MediaStreamTrack[]>;
}>();

export const useVideoDisplay = () => {
  const context = useContext(VideoContext);
  if (!context) {
    throw new Error(
      "useVideoDisplay must be used within a VideoDisplay",
    );
  }
  return context;
};

export const VideoDisplay = (
  props: {
    ref?: (element: HTMLDivElement) => void;
    class?: string;
    stream: MediaStream | null | undefined;
    name: string;
    muted?: boolean;
    playbackActive?: boolean;
    avatar?: string;
    isPlaceholderStream?: boolean;
    onLoadingStateChange?: (
      state:
        | "initial"
        | "loading"
        | "canplay"
        | "playing"
        | "waiting"
        | "stalled"
        | "error",
    ) => void;
  } & ParentProps,
) => {
  const stream = createMemo(() => props.stream ?? null);

  const tracks = createMediaTracks(stream);

  const visibleTracks = createMemo(() =>
    getVisibleVideoDisplayTracks(
      tracks(),
      props.isPlaceholderStream === true,
    ),
  );

  const [isLoaded, setIsLoaded] = createSignal(false);
  const [loadingState, setLoadingState] = createSignal<
    | "initial"
    | "loading"
    | "canplay"
    | "playing"
    | "waiting"
    | "stalled"
    | "error"
  >("initial");

  // 监听加载状态变化并调用回调
  createEffect(() => {
    const currentState = loadingState();
    props.onLoadingStateChange?.(currentState);
  });

  const audioTracks = createMemo(() =>
    visibleTracks().filter(
      (track) => track.kind === "audio",
    ),
  );

  const speaking = createMemo(() => {
    return audioTracks().map((track) => {
      return createCheckVolume(
        () => new MediaStream([track]),
      );
    });
  });

  const anySpeaking = createMemo(() => {
    return speaking().some((speak) => speak());
  });

  const videoTrack = createMemo(
    () =>
      visibleTracks().find(
        (track) => track.kind === "video",
      ) ?? null,
  );

  const videoStream = createMemo(() => {
    const track = videoTrack();
    if (!track) return null;
    return new MediaStream([track]);
  });

  const [videoRef, setVideoRef] =
    createSignal<HTMLVideoElement | null>(null);

  let playbackAttempt = 0;
  let playPending = false;
  let errorReported = false;
  let disposed = false;
  let errorToast: string | number | undefined;
  const dismissError = () => {
    if (errorToast !== undefined) toast.dismiss(errorToast);
    errorToast = undefined;
  };
  const reportError = (
    video: HTMLVideoElement,
    track: MediaStreamTrack,
    error?: unknown,
  ) => {
    if (
      disposed ||
      videoRef() !== video ||
      videoTrack() !== track
    )
      return;
    setIsLoaded(true);
    setLoadingState("error");
    if (errorReported) return;
    errorReported = true;
    const blocked =
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "NotAllowedError";
    errorToast = toast.error(
      `${props.name}: ${t(blocked ? "video.loading_state.autoplay_blocked" : "video.loading_state.error")}`,
      {
        id: `video-playback-${track.id}`,
        ...(blocked ? { duration: Infinity } : {}),
        action: {
          label: t(
            blocked
              ? "video.loading_state.play"
              : "video.loading_state.retry",
          ),
          onClick: () => {
            if (
              disposed ||
              videoRef() !== video ||
              videoTrack() !== track
            )
              return;
            retryLoadVideo();
          },
        },
      },
    );
  };
  const play = (
    video: HTMLVideoElement,
    track: MediaStreamTrack,
  ) => {
    const attempt = ++playbackAttempt;
    playPending = true;
    void video
      .play()
      .catch((error: unknown) => {
        if (attempt !== playbackAttempt) return;
        // Source changes and explicit retries abort earlier play requests.
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        )
          return;
        reportError(video, track, error);
      })
      .finally(() => {
        if (attempt === playbackAttempt)
          playPending = false;
      });
  };

  createEffect(() => {
    const video = videoRef();
    const currentStream = videoStream();
    const track = videoTrack();
    errorReported = false;
    dismissError();
    setIsLoaded(false);
    setLoadingState("initial");
    if (!video) return;

    video.srcObject = currentStream;
    if (!currentStream || !track) return;

    onCleanup(() => {
      ++playbackAttempt;
      playPending = false;
      // Presentation borrows the track: release the media element's decoder,
      // while capture and RTC retain ownership of the live source.
      video.pause();
      video.srcObject = null;
    });
    play(video, track);
  });

  createVideoPlaybackRecovery({
    video: videoRef,
    track: videoTrack,
    active: () => props.playbackActive !== false,
    resume: (video, track) => {
      if (!playPending) play(video, track);
    },
  });

  createEffect(() => {
    if (!videoStream()) setVideoRef(null);
  });

  const retryLoadVideo = () => {
    const video = videoRef();
    const currentStream = videoStream();
    const track = videoTrack();
    if (disposed || !video || !currentStream || !track)
      return;
    errorReported = false;
    dismissError();
    setLoadingState("initial");
    setIsLoaded(false);
    video.srcObject = null;
    video.srcObject = currentStream;
    // Run directly in the toast action's user gesture so autoplay denial can
    // also recover without changing or reacquiring the published track.
    play(video, track);
  };

  onCleanup(() => {
    disposed = true;
    ++playbackAttempt;
    dismissError();
  });

  return (
    <VideoContext.Provider
      value={{ videoRef, videoTrack, audioTracks }}
    >
      <div
        ref={props.ref}
        class={cn("relative overflow-hidden", props.class)}
      >
        <Show
          when={props.stream}
          fallback={
            <ClientAvatar
              data-motion-layout-size="avatar"
              class="meeting-video-avatar absolute top-1/2 left-1/2 size-20
                -translate-x-1/2 -translate-y-1/2 text-2xl"
              avatar={props.avatar}
              name={props.name}
            />
          }
        >
          <Show
            when={videoStream()}
            fallback={
              <ClientAvatar
                data-motion-layout-size="avatar"
                class="meeting-video-avatar absolute top-1/2 left-1/2 size-20
                  -translate-x-1/2 -translate-y-1/2 text-2xl"
                avatar={props.avatar}
                name={props.name}
              />
            }
          >
            <video
              playsinline
              autoplay
              muted={props.muted}
              class="pointer-events-none absolute inset-0 size-full bg-black
                object-contain"
              ref={setVideoRef}
              onLoadedMetadata={() => {
                setIsLoaded(true);
                setLoadingState("loading");
              }}
              onCanPlay={() => {
                setLoadingState("canplay");
              }}
              onPlaying={() => {
                errorReported = false;
                dismissError();
                setIsLoaded(true);
                setLoadingState("playing");
              }}
              onWaiting={() => {
                setLoadingState("waiting");
              }}
              onStalled={() => {
                setLoadingState("stalled");
              }}
              onProgress={() => {
                // 视频正在下载中
                if (
                  loadingState() === "waiting" ||
                  loadingState() === "stalled"
                ) {
                  setLoadingState("loading");
                }
              }}
              onSuspend={() => {
                // 浏览器暂停获取媒体数据
                console.log("Video download suspended");
              }}
              onAbort={() => {
                // 视频下载中断
                console.log("Video download aborted");
              }}
              onError={(event) => {
                const track = videoTrack();
                if (track)
                  reportError(event.currentTarget, track);
              }}
            />
            <Show
              when={
                !isLoaded() ||
                loadingState() === "waiting" ||
                loadingState() === "stalled"
              }
            >
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-2">
                  <Spinner />
                  <div class="rounded bg-black/50 px-2 py-1 text-xs text-white/80">
                    {loadingState() === "initial" &&
                      t("video.loading_state.initial")}
                    {loadingState() === "loading" &&
                      t("video.loading_state.loading")}
                    {loadingState() === "waiting" &&
                      t("video.loading_state.waiting")}
                    {loadingState() === "stalled" &&
                      t("video.loading_state.stalled")}
                  </div>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
        <div
          data-motion-layout-overlay="name"
          class="absolute top-1 right-1 left-1 flex gap-1"
        >
          <Badge
            variant="secondary"
            title={props.name}
            class="max-w-full min-w-0 gap-1 bg-black/50 text-xs text-white
              hover:bg-black/80"
          >
            <span class="truncate">{props.name}</span>
            <IconVolumeUpFilled
              class={cn(
                "size-4 shrink-0",
                anySpeaking() ? "block" : "hidden",
              )}
            />
          </Badge>
        </div>
        {props.children}
      </div>
    </VideoContext.Provider>
  );
};
