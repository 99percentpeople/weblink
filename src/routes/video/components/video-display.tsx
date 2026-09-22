import {
  IconVideoCamOff,
  IconVolumeUpFilled,
  IconSync,
} from "@/components/icons";
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
import { Spinner } from "../../../components/common/spinner";
import { Button } from "@/components/ui/button";
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
    class?: string;
    stream: MediaStream | null | undefined;
    name: string;
    muted?: boolean;
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

  createEffect(() => {
    const video = videoRef();
    const currentStream = videoStream();
    const track = videoTrack();
    if (!video) return;

    video.srcObject = currentStream;
    if (!currentStream || !track) return;

    const controller = new AbortController();
    onCleanup(() => controller.abort());

    const play = () => {
      void video.play().catch((error) => {
        if (
          error instanceof DOMException &&
          error.name === "NotAllowedError"
        ) {
          return;
        }
        console.warn("Video playback failed:", error);
      });
    };

    track.addEventListener("unmute", play, {
      once: true,
      signal: controller.signal,
    });
    play();
  });

  createEffect(() => {
    if (!videoStream()) {
      setVideoRef(null);
    }
  });

  // 重试加载视频
  const retryLoadVideo = () => {
    setLoadingState("initial");
    setIsLoaded(false);

    // 重新设置视频源
    const video = videoRef();
    if (video) {
      const currentStream = videoStream();
      video.srcObject = null;
      setTimeout(() => {
        if (video && currentStream) {
          video.srcObject = currentStream;
        }
      }, 100);
    }
  };

  return (
    <VideoContext.Provider
      value={{ videoRef, videoTrack, audioTracks }}
    >
      <div
        class={cn("relative overflow-hidden", props.class)}
      >
        <Show
          when={props.stream}
          fallback={
            <IconVideoCamOff
              class="text-muted-foreground/10 absolute top-1/2 left-1/2 size-1/2
                -translate-x-1/2 -translate-y-1/2"
            />
          }
        >
          <Show
            when={videoStream()}
            fallback={
              <ClientAvatar
                class="absolute top-1/2 left-1/2 size-14 -translate-x-1/2
                  -translate-y-1/2"
                avatar={props.avatar}
                name={props.name}
              />
            }
          >
            <video
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
              onError={(e) => {
                setIsLoaded(true);
                setLoadingState("error");
                console.error("Video error:", e);
              }}
            />
            <Show
              when={
                !isLoaded() ||
                loadingState() === "waiting" ||
                loadingState() === "stalled" ||
                loadingState() === "error"
              }
            >
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="flex flex-col items-center gap-2">
                  <Show when={loadingState() !== "error"}>
                    <Spinner />
                  </Show>
                  <div class="rounded bg-black/50 px-2 py-1 text-xs text-white/80">
                    {loadingState() === "initial" &&
                      t("video.loading_state.initial")}
                    {loadingState() === "loading" &&
                      t("video.loading_state.loading")}
                    {loadingState() === "waiting" &&
                      t("video.loading_state.waiting")}
                    {loadingState() === "stalled" &&
                      t("video.loading_state.stalled")}
                    {loadingState() === "error" &&
                      t("video.loading_state.error")}
                  </div>
                  <Show when={loadingState() === "error"}>
                    <Button
                      variant="secondary"
                      size="sm"
                      class="mt-2 bg-black/50 text-white"
                      onClick={retryLoadVideo}
                    >
                      <IconSync class="mr-1 size-4" />
                      {t("video.loading_state.retry")}
                    </Button>
                  </Show>
                </div>
              </div>
            </Show>
          </Show>
        </Show>
        <div class="absolute top-1 left-1 flex gap-1">
          <Badge
            variant="secondary"
            class="gap-1 bg-black/50 text-xs text-white hover:bg-black/80"
          >
            {props.name}
            <IconVolumeUpFilled
              class={cn(
                "size-4",
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
