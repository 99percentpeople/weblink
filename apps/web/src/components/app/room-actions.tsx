import type { ParentProps } from "solid-js";
import {
  RoomActionsContext,
  type RoomActions,
} from "@/libs/state/room-actions-context";
export function RoomActionsProvider(
  props: ParentProps<{ value: RoomActions }>,
) {
  return (
    <RoomActionsContext.Provider value={props.value}>
      {props.children}
    </RoomActionsContext.Provider>
  );
}
