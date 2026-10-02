import type { ParentProps } from "solid-js";
import { platform } from "@/libs/platform/runtime";
import { useAppState } from "@/libs/state/app-state-context";
import { useAudioPlayer } from "@/libs/state/audio-player-context";
import { createMeetingMedia } from "@/libs/state/create-meeting-media";
import { createAppPermissions } from "@/libs/state/create-app-permissions";
import { createNativeScreenDialog } from "@/components/dialogs/native-screen-dialog";
import { MeetingMediaProvider as InjectMedia } from "@/components/app/meeting-media-provider";

export function MeetingMediaProvider(props: ParentProps) {
  const state = useAppState();
  const audio = useAudioPlayer();
  // Mocked application contexts still need the shared permission lifetime used
  // by real capture and device discovery. Reuse it when the fixture provides one.
  state.permissions ??= createAppPermissions({
    notifications: platform.notifications,
    outputSupported: audio.outputSupported,
    mediaPermissionPolicy: platform.mediaPermissionPolicy,
  });
  const value = createMeetingMedia({
    state,
    audio,
    nativePicker:
      platform.capture && platform.screenShare
        ? createNativeScreenDialog(platform.capture)
        : undefined,
  });
  return (
    <InjectMedia value={value}>
      {props.children}
    </InjectMedia>
  );
}
