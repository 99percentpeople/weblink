import type { ParentProps } from "solid-js";
import { platform } from "@/libs/platform/runtime";
import { useAppState } from "@/libs/state/app-state-context";
import { useAudioPlayer } from "@/libs/state/audio-player-context";
import { createMeetingMedia } from "@/libs/state/create-meeting-media";
import { createNativeScreenDialog } from "@/components/dialogs/native-screen-dialog";
import { MeetingMediaProvider as InjectMedia } from "@/components/app/meeting-media-provider";

export function MeetingMediaProvider(props: ParentProps) {
  const value = createMeetingMedia({
    state: useAppState(),
    audio: useAudioPlayer(),
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
