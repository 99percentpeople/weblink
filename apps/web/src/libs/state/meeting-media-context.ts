import { createContext, useContext } from "solid-js";
import type { createMeetingMediaController } from "@/libs/application/meeting-media-service";
import type { MeetingDeviceControls } from "@/libs/domain/meeting-devices";
export type MeetingMediaContextValue = {
  media: ReturnType<typeof createMeetingMediaController>;
  devices: MeetingDeviceControls;
};
export const MeetingMediaContext =
  createContext<MeetingMediaContextValue>();

export function useMeetingMedia(): MeetingMediaContextValue {
  const context = useContext(MeetingMediaContext);
  if (!context)
    throw new Error("Meeting media context not found");
  return context;
}
