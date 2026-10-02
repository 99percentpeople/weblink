import { appState } from "@/libs/state/app-state";
import { sessionService } from "@/libs/application/session-service";
import {
  meetingVideoConstraints,
  nativeScreenOptions,
} from "@/libs/application/meeting-video-settings";
import { platform } from "@/libs/platform/runtime";
import {
  createNativeScreenStream,
  getNativeScreenPublication,
} from "@/libs/application/native-screen-service";
import type { createNativeScreenDialog } from "@/components/dialogs/native-screen-dialog";
import { createEffect, on, onCleanup } from "solid-js";
import { createMeetingMediaController } from "@/libs/application/meeting-media-service";
import { createLiveVideoSettings } from "@/libs/application/live-video-settings";
import type { MeetingDeviceControls } from "@/libs/domain/meeting-devices";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { AudioPlayerContextValue } from "./audio-player-context";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

import type { MeetingMediaContextValue } from "@/libs/state/meeting-media-context";

export function createMeetingMedia({
  state,
  audio,
  nativePicker,
}: {
  state: AppStateContextProps;
  audio: AudioPlayerContextValue;
  nativePicker?: ReturnType<
    typeof createNativeScreenDialog
  >;
}): MeetingMediaContextValue {
  const access = state.permissions.media;
  let disposed = false;
  let captureGeneration = 0;
  let pendingNative: AbortController | undefined;
  const browserDisplayMedia =
    typeof navigator.mediaDevices?.getDisplayMedia ===
    "function"
      ? () =>
          navigator.mediaDevices.getDisplayMedia({
            video: meetingVideoConstraints(
              appState.options,
            ),
            audio: true,
            systemAudio: "include",
          } as DisplayMediaStreamOptions)
      : undefined;
  const getDisplayMedia = nativePicker
    ? async () => {
        const generation = captureGeneration;
        const capabilities =
          await platform.getCapabilities();
        if (disposed || generation !== captureGeneration)
          throw new DOMException(
            "Capture cancelled",
            "AbortError",
          );
        if (!capabilities.nativeScreenCapture) {
          if (browserDisplayMedia)
            return browserDisplayMedia();
          throw new Error(t("meeting.media_unavailable"));
        }
        const source = await nativePicker.choose();
        if (disposed || generation !== captureGeneration)
          throw new DOMException(
            "Capture cancelled",
            "AbortError",
          );
        const pending = (pendingNative =
          new AbortController());
        try {
          return await createNativeScreenStream(
            platform.capture!,
            platform.screenShare!,
            source.sourceId,
            pending.signal,
            {
              ...nativeScreenOptions(appState.options),
              audio: source.audio,
            },
            { backend: source.backend },
          );
        } finally {
          if (pendingNative === pending)
            pendingNative = undefined;
        }
      }
    : browserDisplayMedia;
  const media = createMeetingMediaController({
    stream: state.localStream,
    replace: state.replaceLocalStream,
    clear: state.clearLocalStream,
    getUserMedia: (constraints) => {
      if (!navigator.mediaDevices?.getUserMedia)
        return Promise.reject(
          new Error(t("meeting.media_unavailable")),
        );
      return access.capture({
        ...constraints,
        video: constraints.video
          ? {
              ...meetingVideoConstraints(appState.options),
              ...(typeof constraints.video === "object"
                ? constraints.video
                : {}),
            }
          : false,
        audio: constraints.audio
          ? {
              ...appState.media.constraints.microphone,
              ...(typeof constraints.audio === "object"
                ? constraints.audio
                : {}),
            }
          : false,
      });
    },
    getDisplayMedia,
    setDisplayAudioEnabled: async (track, enabled) => {
      await getNativeScreenPublication(
        track,
      )?.setAudioEnabled?.(enabled);
    },
    cancelDisplayMedia: () => {
      captureGeneration++;
      pendingNative?.abort();
      nativePicker?.cancel();
    },
  });
  createEffect(media.sync);
  const shareDefaultScreen = async (
    signal: AbortSignal,
  ) => {
    const existing = state
      .localStream()
      ?.getVideoTracks()
      .find(
        (track) =>
          track.readyState === "live" &&
          getNativeScreenPublication(track)
            ?.controlEligible,
      );
    if (existing)
      return getNativeScreenPublication(existing)?.sourceId;
    const capture = platform.capture;
    const share = platform.screenShare;
    if (!capture || !share || signal.aborted) return;
    const source = (await capture.sources()).find(
      (source) => source.kind === "monitor",
    );
    if (!source || disposed || signal.aborted) return;
    let captured: MediaStream | undefined;
    await media.addSharing(
      async () =>
        (captured = await createNativeScreenStream(
          capture,
          share,
          source.id,
          signal,
          {
            ...nativeScreenOptions(appState.options),
            audio: true,
          },
          {
            backend:
              appState.options.nativeScreenCaptureBackend,
          },
        )),
      signal,
    );
    const track = captured?.getVideoTracks()[0];
    return track &&
      state.localStream()?.getVideoTracks().includes(track)
      ? getNativeScreenPublication(track)?.sourceId
      : undefined;
  };
  sessionService.remoteControl.screen.share =
    shareDefaultScreen;
  // A capture approved after leaving must not publish into the next room.
  createEffect(
    on(
      state.activeRoomConversationId,
      () => media.cancelRequests(),
      { defer: true },
    ),
  );
  const report = (error: unknown) => {
    if (!disposed && error)
      toast.error(
        `${t("meeting.media_error")}: ${error instanceof Error ? error.message : String(error)}`,
      );
  };
  const liveSettings = createLiveVideoSettings({
    publication: getNativeScreenPublication,
    error: report,
  });
  createEffect(() =>
    liveSettings.sync(
      state.localStream(),
      appState.options,
    ),
  );
  createEffect(on(media.error, report));
  createEffect(on(access.discoveryError, report));
  createEffect(on(access.error, report));
  createEffect(
    on([media.microphoneOn, media.cameraOn], (enabled) => {
      if (enabled.some(Boolean)) void access.refresh();
    }),
  );
  onCleanup(() => {
    if (
      sessionService.remoteControl.screen.share ===
      shareDefaultScreen
    )
      sessionService.remoteControl.screen.share = undefined;
    disposed = true;
    liveSettings.dispose();
    media.dispose();
  });
  const devices: MeetingDeviceControls = {
    access: {
      state: access.state,
      requesting: access.requesting,
      needsPermission: access.needsPermission,
      outputNeedsMicrophone: access.outputNeedsMicrophone,
      request: async (kind) => {
        const output = await access.request(kind);
        if (output && !disposed)
          await devices.selectOutput(output.deviceId);
      },
    },
    list: access.devices,
    refreshing: access.refreshing,
    refresh: () => {
      void access.refresh();
    },
    microphoneId: media.selectedMicrophoneId,
    cameraId: media.selectedCameraId,
    selectMicrophone: media.selectMicrophone,
    selectCamera: media.selectCamera,
    outputId: audio.outputDeviceId,
    outputSupported: audio.outputSupported,
    outputBusy: audio.outputBusy,
    selectOutput: async (id) => {
      try {
        await audio.setOutputDevice(id);
      } catch (error) {
        report(error);
      }
    },
  };
  return { media, devices };
}
