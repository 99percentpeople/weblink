import type { ParentProps } from "solid-js";
import { useAppState } from "@/libs/state/app-state-context";
import { createRoomActions } from "@/libs/state/create-room-actions";
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { RoomActionsProvider as InjectActions } from "@/components/app/room-actions";

export function RoomActionsProvider(props: ParentProps) {
  const value = createRoomActions({
    state: useAppState(),
    dialog: createRoomDialog(),
  });
  return (
    <InjectActions value={value}>
      {props.children}
    </InjectActions>
  );
}
