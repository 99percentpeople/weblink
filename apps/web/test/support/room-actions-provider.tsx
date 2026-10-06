import type { ParentProps } from "solid-js";
import { useAppState } from "@/libs/state/app-state-context";
import { createRoomActions } from "@/libs/state/create-room-actions";
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { RoomActionsProvider as InjectActions } from "@/components/app/room-actions";
import { appState } from "@/libs/state/app-state";
import { getRoomNamespace } from "@/libs/application/room-identity";

export function RoomActionsProvider(props: ParentProps) {
  const value = createRoomActions({
    state: useAppState(),
    dialog: createRoomDialog(),
    history: {
      initialize: async () => {},
      conversations: appState.message.conversations,
    },
    namespace: getRoomNamespace(),
  });
  return (
    <InjectActions value={value}>
      {props.children}
    </InjectActions>
  );
}
