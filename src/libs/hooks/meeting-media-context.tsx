import {
  createContext,
  createEffect,
  on,
  onCleanup,
  useContext,
  type ParentProps,
} from "solid-js";
import { createMeetingMediaController } from "@/libs/application/meeting-media-service";
import type { MeetingDeviceControls } from "@/libs/domain/meeting-devices";
import { useAppState } from "@/libs/state/app-state-context";
import { useAudioPlayer } from "@/routes/home/components/audio-player";
import { createMediaDevices } from "./media-devices";
import { createMediaDeviceAccess } from "./media-device-access";
import { t } from "@/i18n";
import { toast } from "solid-sonner";

export type MeetingMediaContextValue = {
  media: ReturnType<typeof createMeetingMediaController>;
  devices: MeetingDeviceControls;
};
const MeetingMediaContext =
  createContext<MeetingMediaContextValue>();

export function useMeetingMedia(): MeetingMediaContextValue {
  const context = useContext(MeetingMediaContext);
  if (!context)
    throw new Error("Meeting media context not found");
  return context;
}

/** The toolbar and room dialog own views of the same application capture state. */
export function MeetingMediaProvider(props: ParentProps) {
  const state = useAppState();
  const audio = useAudioPlayer();
  const discovery = createMediaDevices();
  const access = createMediaDeviceAccess({
    devices: discovery.devices,
    refreshing: discovery.refreshing,
    refresh: discovery.updateDevices,
    outputSupported: audio.outputSupported,
  });
  let disposed = false;
  const media = createMeetingMediaController({
    stream: state.localStream,
    replace: state.replaceLocalStream,
    clear: state.clearLocalStream,
    getUserMedia: (constraints) => {
      if (!navigator.mediaDevices?.getUserMedia)
        return Promise.reject(
          new Error(t("meeting.media_unavailable")),
        );
      return navigator.mediaDevices.getUserMedia(
        constraints,
      );
    },
    getDisplayMedia: () => {
      if (!navigator.mediaDevices?.getDisplayMedia)
        return Promise.reject(
          new Error(t("meeting.sharing_unavailable")),
        );
      const options: DisplayMediaStreamOptions & {
        systemAudio: "include";
      } = {
        video: true,
        audio: true,
        systemAudio: "include",
      };
      return navigator.mediaDevices.getDisplayMedia(
        options,
      );
    },
  });
  createEffect(media.sync);
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
  createEffect(on(media.error, report));
  createEffect(on(discovery.error, report));
  createEffect(on(access.error, report));
  createEffect(
    on([media.microphoneOn, media.cameraOn], (enabled) => {
      if (enabled.some(Boolean)) void access.refresh();
    }),
  );
  onCleanup(() => {
    disposed = true;
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
    refreshing: discovery.refreshing,
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
  return (
    <MeetingMediaContext.Provider
      value={{ media, devices }}
    >
      {props.children}
    </MeetingMediaContext.Provider>
  );
}
