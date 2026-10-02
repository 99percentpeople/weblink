import type { ParentProps } from "solid-js";
import { useLocation, useNavigate } from "@solidjs/router";
import { useAppState } from "@/libs/state/app-state-context";
import { useMeetingMedia } from "@/libs/state/meeting-media-context";
import { createMeetingSession } from "@/libs/state/create-meeting-session";
import { createMeetingMainViewConfirmation } from "@/routes/home/components/meeting-main-view-dialog";
import { MeetingSessionProvider as InjectSession } from "@/components/app/meeting-session-provider";

export function MeetingSessionProvider(props: ParentProps) {
  const confirmation = createMeetingMainViewConfirmation();
  const value = createMeetingSession({
    state: useAppState(),
    media: useMeetingMedia(),
    location: useLocation(),
    navigate: useNavigate(),
    confirmation,
  });
  return (
    <InjectSession
      value={value}
      confirmation={confirmation.Dialog}
    >
      {props.children}
    </InjectSession>
  );
}
