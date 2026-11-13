import {
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { toast } from "solid-sonner";
import { EventBus } from "@weblink/platform/events";
import { t } from "@/i18n";
import {
  RecordingService,
  type RecordingInput,
  type RecordingState,
} from "@/libs/application/recording-service";
import { getNativeScreenPublication } from "@/libs/application/native-screen-service";
import { getMeetingAudioSource } from "@/libs/application/meeting-media-service";
import { getRemoteAudioVideoTrackId } from "@/routes/home/components/meeting-audio-sources";
import { createCacheManager } from "@/libs/application/cache-service";
import { sessionService } from "@/libs/application/session-service";
import { localFileErrorDetail } from "@/libs/utils/local-file-error";
import { appState } from "./app-state";
import { platform } from "@/libs/platform/runtime";
import type { AppStateContextProps } from "./app-state-context";

interface RecordingPresentation {
  participantName?: string;
  avatar?: string;
  sourceLabel?: string;
}
export type RecordingStatus = RecordingState &
  RecordingPresentation;

export interface SavedRecording {
  id: string;
  fileName: string;
}

function selectRecordingInput(
  video: MediaStreamTrack,
  audio: readonly MediaStreamTrack[],
  local: boolean,
  remoteScreen?: MediaStream | null,
): RecordingInput {
  const publication = local
    ? getNativeScreenPublication(video)
    : undefined;
  const packets =
    publication?.getRecordingSources?.bind(publication);
  if (publication?.openRecording)
    return {
      kind: "native",
      packets,
      open: publication.openRecording.bind(publication),
    };

  const presentation =
    platform.videoPresentation?.recording?.(video);
  if (presentation)
    return {
      kind: "native",
      packets,
      async open(signal, ended) {
        const input = await presentation(signal, ended);
        return {
          start: input.start,
          close: input.close,
          stream: new MediaStream([
            ...input.stream.getVideoTracks(),
            ...audio,
          ]),
        };
      },
    };

  if (
    remoteScreen
      ?.getVideoTracks()
      .some((track) => track === video)
  )
    return {
      kind: "received-screen",
      audioSkew:
        audio.length === 1
          ? sessionService?.getScreenRecordingAudioClock(
              video,
              audio[0],
            )
          : undefined,
    };
  return {
    kind: local ? "local-tracks" : "remote-tracks",
    packets: () =>
      sessionService?.getRecordingVideoSources(
        video,
        audio,
      ) ?? [],
  };
}

export function createRecording(app: AppStateContextProps) {
  const manager = createCacheManager();
  const bus = new EventBus<{ saved: SavedRecording }>(
    "recording",
    (error) =>
      console.warn(
        "Recording completion listener failed",
        error,
      ),
  );
  const [state, setState] =
    createSignal<RecordingStatus | null>(null);
  let presentation: RecordingPresentation = {};
  const failed = (error: unknown) =>
    toast.error(t("recording.failed"), {
      description:
        localFileErrorDetail(error) ?? String(error),
      classNames: { description: "toast-error-details" },
      duration: 30000,
      closeButton: true,
    });
  const service = new RecordingService({
    storage: manager.storage,
    container: () => appState.options.recordingContainer,
    changed: (value) =>
      setState(
        value ? { ...value, ...presentation } : null,
      ),
    complete: async ({ id }) => {
      const cache = await manager.createCache(id);
      const file =
        await manager.library.verifyReceived(cache);
      if (!file)
        throw new Error("Saved recording is unavailable");
      // Publish only after VFS commit and library verification. Notifications
      // retain the identity, never a potentially large or stale file snapshot.
      bus.emit("saved", { id, fileName: file.name });
    },
    failed,
  });
  createEffect(() => {
    state();
    service.sync();
  });
  createEffect(
    on(
      app.activeRoomConversationId,
      () => {
        void service.stop();
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    bus.dispose();
    void service.stop();
  });
  return {
    events: bus.events,
    state,
    supported: () => service.supported,
    pause: () => service.pause(),
    resume: () => service.resume(),
    stop: () => {
      void service.stop();
    },
    start(
      options: RecordingPresentation & {
        id: string;
        name: string;
        local: boolean;
        participantId?: string;
        kind?: string;
        video: MediaStreamTrack;
        audio: readonly MediaStreamTrack[];
      },
    ) {
      if (state()) return;
      if (options.local)
        app.screenSharing.retain(options.video);
      presentation = {
        participantName: options.participantName,
        avatar: options.avatar,
        sourceLabel: options.sourceLabel,
      };
      const remote = () =>
        options.local
          ? undefined
          : appState.session.clientViewData[
              options.participantId ?? ""
            ];
      const streams = () =>
        options.local
          ? [app.localStream()]
          : [
              remote()?.stream,
              remote()?.nativeScreenStream,
            ];
      const allTracks = () =>
        streams().flatMap(
          (stream) => stream?.getTracks() ?? [],
        );
      const audio =
        options.kind === "camera" ||
        options.kind === "video"
          ? allTracks().filter(
              (track) =>
                track.kind === "audio" &&
                (options.local
                  ? getMeetingAudioSource(track).kind ===
                    "microphone"
                  : !getRemoteAudioVideoTrackId(
                      track.id,
                      remote() ?? {},
                    )),
            )
          : [...options.audio];
      void service
        .start({
          id: options.id,
          name: options.name,
          input: selectRecordingInput(
            options.video,
            audio,
            options.local,
            remote()?.nativeScreenStream,
          ),
          video: options.video,
          audio,
          available: () =>
            options.video.readyState === "live" &&
            [options.video, ...audio].every((track) =>
              allTracks().includes(track),
            ),
        })
        .catch(() => {}); // The service owns failure notices and cleanup.
    },
  };
}
export type RecordingControls = ReturnType<
  typeof createRecording
>;
