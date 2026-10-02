import { createContext, useContext } from "solid-js";
import type { createMeetingSession } from "./create-meeting-session";
export type MeetingSession = ReturnType<
  typeof createMeetingSession
>;
export const MeetingSessionContext =
  createContext<MeetingSession>();
export function useMeetingSession(): MeetingSession {
  const session = useContext(MeetingSessionContext);
  if (!session)
    throw new Error("Meeting session context not found");
  return session;
}
