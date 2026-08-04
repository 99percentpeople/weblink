import "./index.css";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { Button } from "@/components/ui/button";
import {
  localStream,
  setDisplayStream,
} from "@/libs/stream";
import { t } from "@/i18n";
import {
  IconDelete,
  IconFullscreen,
  IconMeetingRoom,
  IconMic,
  IconMicOff,
  IconPip,
  IconPipExit,
  IconScreenShare,
  IconSettings,
  IconStopScreenShare,
  IconVideoCam,
  IconVideoCamOff,
  IconViewCompactAlt,
  IconVolumeOff,
  IconVolumeUp,
} from "@/components/icons";
import { GripIcon } from "lucide-solid";
import { cn } from "@/libs/cn";
import { ClientInfo } from "@/libs/core/type";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { Dynamic } from "solid-js/web";
import { createMediaSelectionDialog } from "@/components/dialogs/media-selection-dialog";
import { createApplyConstraintsDialog } from "@/components/dialogs/media-constraints-dialogs";
import { useAudioPlayer } from "./components/audio-player";
import {
  useVideoDisplay,
  VideoDisplay,
} from "./components/video-display";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { createMediaTracks } from "@/libs/hooks/tracks";
import { createPictureInPicture } from "@/libs/hooks/picture-in-picture";
import { createFullscreen } from "@/libs/hooks/fullscreen";
import { FlexButton } from "./components/flex-button";
import {
  GridItemContent,
  GridStack,
  GridStackRef,
  SavedGridItem,
} from "@/libs/gridstack";
import { createElementSize } from "@solid-primitives/resize-observer";
import {
  GridStackOptions,
  numberOrString,
} from "gridstack";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { getInitials } from "@/libs/utils/name";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Switch,
  SwitchControl,
  SwitchThumb,
} from "@/components/ui/switch";
import { makePersisted } from "@solid-primitives/storage";
import { appState } from "@/libs/state/app-state";

const [removedClientIds, setRemovedClientIds] =
  createSignal<string[]>([]);

export default function Video() {
  const isMobile = createIsMobile();

  const { setPlay, playState, hasAudio } = useAudioPlayer();

  const [gridRef, setGridRef] =
    createSignal<GridStackRef>();

  const gridSize = createElementSize(gridRef);

  const gridCellHeight = createMemo<numberOrString>(() => {
    if (!gridSize.width) return "128px";
    const columns = isMobile() ? 6 : 12;
    return `${(gridSize.width / columns) * (9 / 16)}px`;
  });

  const gridColumn = createMemo<number>(() => {
    return isMobile() ? 1 : 12;
  });

  const [float, setFloat] = makePersisted(
    createSignal(false),
    {
      storage: sessionStorage,
      name: "video_float",
    },
  );

  const gridOptions = createMemo(
    () =>
      ({
        draggable: {
          handle: ".custom-drag-handle",
          appendTo: "body",
          scroll: false,
        },
        cellHeight: gridCellHeight(),
        column: gridColumn(),
        animate: true,
        margin: 1,
        minRow: 1,
        float: float(),
        resizable: {
          handles: "se",
        },
        acceptWidgets: true,
        removable: "[data-gs-removal-zone]",
        styleInHead: true,
      }) satisfies GridStackOptions,
  );

  createEffect(() => {
    const availableClientIds = Object.values(
      appState.session.clientViewData,
    ).map((client) => client.clientId);
    const newRemovedClientIds = untrack(
      removedClientIds,
    ).filter((removedClientId) =>
      availableClientIds.includes(removedClientId),
    );
    setRemovedClientIds(newRemovedClientIds);
  });

  const [dragging, setDragging] = createSignal(false);

  return (
    <>
      <div
        class={cn(
          "fixed bottom-8 left-1/2 size-28 -translate-x-1/2",
          "border-destructive rounded-xl border-2 border-dashed",
          "bg-destructive/10 hover:border-destructive/80 transition-all",
          `hover:bg-destructive/20 visible z-10 touch-manipulation
          opacity-100`,
          !dragging() &&
            "invisible scale-[0.95] cursor-move opacity-0",
        )}
        data-gs-removal-zone
      >
        <div class="text-destructive flex h-full items-center justify-center">
          <IconDelete class="size-8" />
        </div>
      </div>
      <div class="scrollbar-none flex size-full flex-col overflow-y-auto">
        <div
          class="border-border bg-background/80 sticky top-0 z-10 flex h-12
            w-full items-center gap-2 border-b px-4 backdrop-blur
            sm:top-0"
        >
          <h4 class="h4">
            {appState.roomStatus.roomId ? (
              <p class="space-x-1 [&>*]:align-middle [&>svg]:inline">
                <IconMeetingRoom class="inline size-6" />
                <span>{appState.roomStatus.roomId}</span>
              </p>
            ) : (
              t("video.title")
            )}
          </h4>
          <div class="flex-1"></div>
          <Show when={gridRef()}>
            {(gridRef) => (
              <>
                <Tooltip>
                  <TooltipTrigger
                    as={Switch}
                    class="flex items-center justify-between"
                    checked={float()}
                    onChange={(isChecked: boolean) =>
                      setFloat(isChecked)
                    }
                  >
                    <SwitchControl>
                      <SwitchThumb />
                    </SwitchControl>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("video.float")}
                  </TooltipContent>
                </Tooltip>
                <Show when={removedClientIds().length > 0}>
                  <Popover>
                    <PopoverTrigger
                      as={Button}
                      size="icon"
                      class="size-8"
                      variant="secondary"
                    >
                      <IconDelete class="size-4" />
                    </PopoverTrigger>
                    <PopoverContent class="flex flex-col gap-2">
                      <h4 class="h4">
                        {t("common.action.restore")}
                      </h4>
                      <div class="grid grid-cols-4 gap-2">
                        <For each={removedClientIds()}>
                          {(clientId) => (
                            <Show
                              when={
                                appState.session
                                  .clientViewData[clientId]
                              }
                            >
                              {(client) => (
                                <Avatar
                                  class="size-10 cursor-pointer self-center"
                                  onClick={() => {
                                    setRemovedClientIds(
                                      (prev) =>
                                        prev.filter(
                                          (id) =>
                                            id !== clientId,
                                        ),
                                    );
                                  }}
                                >
                                  <AvatarImage
                                    src={
                                      client().avatar ??
                                      undefined
                                    }
                                  />
                                  <AvatarFallback>
                                    {getInitials(
                                      client().name,
                                    )}
                                  </AvatarFallback>
                                </Avatar>
                              )}
                            </Show>
                          )}
                        </For>
                      </div>
                    </PopoverContent>
                  </Popover>
                </Show>
                <Tooltip>
                  <TooltipTrigger
                    as={Button}
                    size="icon"
                    class="size-8"
                    variant="secondary"
                    onClick={() => gridRef().compact()}
                  >
                    <IconViewCompactAlt class="size-4" />
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("video.compact_layout")}
                  </TooltipContent>
                </Tooltip>
              </>
            )}
          </Show>
          <Show when={hasAudio()}>
            <Tooltip>
              <TooltipTrigger
                as={Button}
                onClick={() => setPlay(!playState())}
                size="icon"
                class="size-8"
                variant={
                  playState() ? "secondary" : "default"
                }
              >
                <Dynamic
                  component={
                    playState()
                      ? IconVolumeUp
                      : IconVolumeOff
                  }
                  class="size-4"
                />
              </TooltipTrigger>
              <TooltipContent>
                {playState()
                  ? t("video.global_mute")
                  : t("video.global_unmute")}
              </TooltipContent>
            </Tooltip>
          </Show>
        </div>

        <GridStack
          class="flex-1"
          ref={setGridRef}
          options={gridOptions()}
          onDragStatusChange={(event, item, drag) => {
            setDragging(drag);
          }}
          onRemove={(event, items) => {
            items.forEach((item) => {
              const clientId = item.el?.id;
              if (clientId) {
                setRemovedClientIds((prev) => [
                  ...prev,
                  clientId,
                ]);
              }
            });
          }}
        >
          <SavedGridItem
            w={6}
            h={6}
            id={appState.profile.clientId}
            noRemovable
          >
            <GridItemContent class="bg-muted relative rounded-lg shadow-lg">
              <div
                class="custom-drag-handle absolute top-2 right-2 z-10 flex h-6 w-6
                  cursor-move items-center justify-center rounded bg-black/50
                  text-white opacity-0 transition-opacity hover:opacity-100"
              >
                <GripIcon class="size-4" />
              </div>

              <VideoDisplay
                class="absolute inset-0"
                stream={localStream()}
                name={`${appState.profile.name} (You)`}
                avatar={
                  appState.profile.avatar ?? undefined
                }
                muted={true}
              >
                <LocalToolbar
                  client={
                    appState.roomStatus.profile ?? undefined
                  }
                  class={cn(
                    "absolute top-1 flex gap-1",
                    "left-1/2 -translate-x-1/2",
                  )}
                />
              </VideoDisplay>
            </GridItemContent>
          </SavedGridItem>
          <For
            each={Object.values(
              appState.session.clientViewData,
            ).filter(
              (client) =>
                !removedClientIds().includes(
                  client.clientId,
                ),
            )}
          >
            {(client) => {
              return (
                <SavedGridItem
                  w={6}
                  h={6}
                  id={client.clientId}
                >
                  <GridItemContent class="bg-muted relative rounded-lg shadow-lg">
                    <div
                      class="custom-drag-handle absolute top-2 right-2 z-10 flex h-6 w-6
                        cursor-move items-center justify-center rounded bg-black/50
                        text-white opacity-0 transition-opacity hover:opacity-100"
                    >
                      <GripIcon class="size-4" />
                    </div>

                    <VideoDisplay
                      class="absolute inset-0"
                      stream={client.stream}
                      name={client.name}
                      avatar={client.avatar ?? undefined}
                      isPlaceholderStream={
                        client.streamState === "placeholder"
                      }
                      hidePlaceholderVideo
                      muted={true}
                    >
                      <RemoteToolbar
                        class={cn(
                          "absolute top-1 flex gap-1",
                          "left-1/2 -translate-x-1/2",
                        )}
                        client={client}
                      />
                    </VideoDisplay>
                  </GridItemContent>
                </SavedGridItem>
              );
            }}
          </For>
        </GridStack>
      </div>
    </>
  );
}

const RemoteToolbar = (props: {
  client?: ClientInfo;
  class?: string;
}) => {
  const { videoRef, audioTracks } = useVideoDisplay();

  const [muted, setMuted] = createSignal(false);

  const {
    isInPip,
    isThisElementInPip,
    isSupported: isPipSupported,
    requestPictureInPicture,
    exitPictureInPicture,
  } = createPictureInPicture(videoRef);

  onMount(() => {
    setMuted(audioTracks().some((track) => !track.enabled));
    createEffect(() => {
      audioTracks().forEach((track) => {
        track.enabled = !muted();
      });
    });
  });

  const {
    isSupported: isFullscreenSupported,
    isFullscreen,
    requestFullscreen,
    exitFullscreen,
    isThisElementFullscreen,
  } = createFullscreen(videoRef);

  return (
    <div
      class={cn(
        "flex gap-1 rounded-full bg-black/50",
        props.class,
      )}
    >
      <Show when={audioTracks().length > 0}>
        <FlexButton
          size="sm"
          variant={muted() ? "default" : "secondary"}
          onClick={() => setMuted(!muted())}
          icon={
            <Dynamic
              component={
                muted() ? IconVolumeOff : IconVolumeUp
              }
              class="size-4"
            />
          }
        >
          {muted()
            ? t("common.action.unmute")
            : t("common.action.mute")}
        </FlexButton>
      </Show>
      <Show when={videoRef()}>
        {(ref) => (
          <>
            <Show when={isFullscreenSupported()}>
              <FlexButton
                icon={<IconFullscreen class="size-4" />}
                onClick={() => {
                  if (isThisElementFullscreen()) {
                    exitFullscreen();
                  } else {
                    requestFullscreen();
                  }
                }}
                variant={
                  isThisElementFullscreen()
                    ? "default"
                    : "secondary"
                }
              >
                {isThisElementFullscreen()
                  ? t("common.action.exit_fullscreen")
                  : isFullscreen()
                    ? t("common.action.switch_fullscreen")
                    : t("common.action.fullscreen")}
              </FlexButton>
            </Show>
            <Show when={isPipSupported()}>
              <FlexButton
                icon={
                  <Dynamic
                    component={
                      isInPip() ? IconPipExit : IconPip
                    }
                    class="size-4"
                  />
                }
                onClick={() => {
                  if (isThisElementInPip()) {
                    exitPictureInPicture();
                  } else {
                    requestPictureInPicture();
                  }
                }}
                variant={
                  isThisElementInPip()
                    ? "default"
                    : "secondary"
                }
              >
                {isThisElementInPip()
                  ? t(
                      "common.action.exit_picture_in_picture",
                    )
                  : isInPip()
                    ? t(
                        "common.action.switch_picture_in_picture",
                      )
                    : t("common.action.picture_in_picture")}
              </FlexButton>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

const LocalToolbar = (props: {
  client?: ClientInfo;
  class?: string;
}) => {
  const closeStream = async () => {
    setDisplayStream(null);
  };

  const { open: openMediaSelection } =
    createMediaSelectionDialog();

  const { open: openApplyConstraintsDialog } =
    createApplyConstraintsDialog();

  const tracks = createMediaTracks(
    () => localStream() ?? null,
  );

  const audioTracks = createMemo(() =>
    tracks().filter((track) => track.kind === "audio"),
  );

  const videoTrack = createMemo(() =>
    tracks().find((track) => track.kind === "video"),
  );

  const microphoneAudioTrack = createMemo(() => {
    return (
      audioTracks().find((track) => {
        return track.contentHint === "speech";
      }) ?? null
    );
  });

  const speakerAudioTrack = createMemo(() => {
    return (
      audioTracks().find((track) => {
        return track.contentHint === "music";
      }) ?? null
    );
  });

  const [microphoneMuted, setMicrophoneMuted] =
    createSignal();
  createEffect(() => {
    const track = microphoneAudioTrack();
    if (!track) return;

    if (microphoneMuted() === undefined) {
      setMicrophoneMuted(!track.enabled);
    } else {
      track.enabled = !microphoneMuted();
    }
  });

  const [speakerMuted, setSpeakerMuted] = createSignal();
  createEffect(() => {
    const track = speakerAudioTrack();
    if (!track) return;

    if (speakerMuted() === undefined) {
      setSpeakerMuted(!track.enabled);
    } else {
      track.enabled = !speakerMuted();
    }
  });

  const [videoMuted, setVideoMuted] = createSignal();
  createEffect(() => {
    const track = videoTrack();
    if (track) {
      if (videoMuted() === undefined) {
        setVideoMuted(!track.enabled);
      } else {
        track.enabled = !videoMuted();
      }
    }
  });

  return (
    <div
      class={cn(
        "flex gap-1 rounded-full bg-black/50",
        props.class,
      )}
    >
      <FlexButton
        size="sm"
        onClick={async () => {
          const { result } = await openMediaSelection();
          if (result) {
            setDisplayStream(result);
          }
        }}
        icon={<IconScreenShare class="size-4" />}
        variant={localStream() ? "secondary" : "default"}
      >
        {localStream()
          ? t("common.action.change")
          : t("common.action.select")}
      </FlexButton>
      <Show when={speakerAudioTrack()}>
        <FlexButton
          size="sm"
          variant={speakerMuted() ? "default" : "secondary"}
          onClick={() => {
            setSpeakerMuted(!speakerMuted());
          }}
          icon={
            <Dynamic
              component={
                speakerMuted()
                  ? IconVolumeOff
                  : IconVolumeUp
              }
              class="size-4"
            />
          }
        >
          {speakerMuted()
            ? t("common.action.unmute")
            : t("common.action.mute")}
        </FlexButton>
      </Show>
      <Show when={microphoneAudioTrack()}>
        <FlexButton
          size="sm"
          variant={
            microphoneMuted() ? "default" : "secondary"
          }
          onClick={() => {
            setMicrophoneMuted(!microphoneMuted());
          }}
          icon={
            <Dynamic
              component={
                microphoneMuted() ? IconMicOff : IconMic
              }
              class="size-4"
            />
          }
        >
          {microphoneMuted()
            ? t("common.action.unmute")
            : t("common.action.mute")}
        </FlexButton>
      </Show>
      <Show when={videoTrack()}>
        <FlexButton
          size="sm"
          onClick={() => setVideoMuted(!videoMuted())}
          variant={videoMuted() ? "default" : "secondary"}
          icon={
            <Dynamic
              component={
                videoMuted()
                  ? IconVideoCamOff
                  : IconVideoCam
              }
              class="size-4"
            />
          }
        >
          {videoMuted()
            ? t("common.action.continue")
            : t("common.action.pause")}
        </FlexButton>
      </Show>
      <Show when={audioTracks().length > 0 || videoTrack()}>
        <FlexButton
          size="sm"
          onClick={() => {
            const stream = localStream();
            if (stream) {
              openApplyConstraintsDialog(stream);
            }
          }}
          variant="secondary"
          icon={<IconSettings class="size-4" />}
        >
          {t("common.action.settings")}
        </FlexButton>
      </Show>
      <Show when={localStream()}>
        <FlexButton
          size="sm"
          onClick={() => closeStream()}
          variant="destructive"
          icon={<IconStopScreenShare class="size-4" />}
        >
          {t("common.action.close")}
        </FlexButton>
      </Show>
    </div>
  );
};
