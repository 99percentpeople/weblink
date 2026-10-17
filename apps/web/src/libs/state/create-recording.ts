import {
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import {
  RecordingService,
  type RecordingState,
} from "@/libs/application/recording-service";
import { getNativeScreenPublication } from "@/libs/application/native-screen-service";
import { getMeetingAudioSource } from "@/libs/application/meeting-media-service";
import { getRemoteAudioVideoTrackId } from "@/routes/home/components/meeting-audio-sources";
import { createCacheManager } from "@/libs/application/cache-service";
import { localFileErrorDetail } from "@/libs/utils/local-file-error";
import { appState } from "./app-state";
import type { AppStateContextProps } from "./app-state-context";

interface RecordingPresentation {
  participantName?: string;
  avatar?: string;
  sourceLabel?: string;
}
export type RecordingStatus = RecordingState &
  RecordingPresentation;

export function createRecording(app: AppStateContextProps) {
  const manager = createCacheManager();
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
    changed: (value) =>
      setState(
        value ? { ...value, ...presentation } : null,
      ),
    complete: async ({ id }) => {
      const cache = await manager.createCache(id);
      await manager.library.verifyReceived(cache);
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
    void service.stop();
  });
  return {
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
      presentation = {
        participantName: options.participantName,
        avatar: options.avatar,
        sourceLabel: options.sourceLabel,
      };
      const streams = () =>
        options.local
          ? [app.localStream()]
          : [
              appState.session.clientViewData[
                options.participantId ?? ""
              ]?.stream,
              appState.session.clientViewData[
                options.participantId ?? ""
              ]?.nativeScreenStream,
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
                      appState.session.clientViewData[
                        options.participantId ?? ""
                      ] ?? {},
                    )),
            )
          : [...options.audio];
      const publication = options.local
        ? getNativeScreenPublication(options.video)
        : undefined;
      const open =
        publication?.openRecording?.bind(publication);
      void service
        .start({
          id: options.id,
          name: options.name,
          local: options.local,
          video: options.video,
          audio,
          available: () =>
            options.video.readyState === "live" &&
            [options.video, ...audio].every((track) =>
              allTracks().includes(track),
            ),
          open,
        })
        .catch(() => {}); // The service owns failure notices and cleanup.
    },
  };
}
export type RecordingControls = ReturnType<
  typeof createRecording
>;
