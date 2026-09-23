import {
  createContext,
  createSignal,
  useContext,
  type ParentProps,
} from "solid-js";
import { toast } from "solid-sonner";
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";

export function createRoomActions() {
  const state = useAppState();
  const dialog = createRoomDialog();
  const [busy, setBusy] = createSignal(false);
  const available = () =>
    !busy() &&
    appState.session.clientServiceStatus === "disconnected";
  const edit = async () => {
    if (!available()) return;
    setBusy(true);
    try {
      await dialog.open();
    } finally {
      setBusy(false);
    }
  };
  const join = async () => {
    if (!available()) return;
    setBusy(true);
    try {
      if (
        appState.profile.initalJoin ||
        !appState.profile.name.trim() ||
        !appState.profile.roomId.trim()
      ) {
        if ((await dialog.open()).cancel) return;
      }
      await state.joinRoom();
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setBusy(false);
    }
  };
  return { join, edit, busy };
}

const RoomActionsContext =
  createContext<ReturnType<typeof createRoomActions>>();

export function RoomActionsProvider(props: ParentProps) {
  const actions = createRoomActions();
  return (
    <RoomActionsContext.Provider value={actions}>
      {props.children}
    </RoomActionsContext.Provider>
  );
}

export function useRoomActions() {
  const actions = useContext(RoomActionsContext);
  if (!actions)
    throw new Error("RoomActionsProvider is missing");
  return actions;
}
