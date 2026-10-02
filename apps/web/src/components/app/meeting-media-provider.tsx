import type { ParentProps } from "solid-js";
import {
  MeetingMediaContext,
  type MeetingMediaContextValue,
} from "@/libs/state/meeting-media-context";
export function MeetingMediaProvider(
  props: ParentProps<{ value: MeetingMediaContextValue }>,
) {
  return (
    <MeetingMediaContext.Provider value={props.value}>
      {props.children}
    </MeetingMediaContext.Provider>
  );
}
