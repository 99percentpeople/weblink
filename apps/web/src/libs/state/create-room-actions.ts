import { userErrorMessage } from "@/libs/user-error";
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import type { createRoomDialog } from "@/components/dialogs/join-dialog";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";

export function createRoomActions({
  state,
  dialog,
}: {
  state: Pick<AppStateContextProps, "joinRoom">;
  dialog: Pick<ReturnType<typeof createRoomDialog>, "open">;
}) {
  const [busy, setBusy] = createSignal(false);
  const available = () =>
    !busy() &&
    appState.session.clientServiceStatus === "disconnected";
  const connect = async (
    configure: boolean,
    takeover = false,
  ) => {
    if (!available()) return;
    setBusy(true);
    try {
      if (
        !takeover &&
        (configure ||
          appState.profile.initalJoin ||
          !appState.profile.name.trim() ||
          !appState.profile.roomId.trim())
      ) {
        if ((await dialog.open()).cancel) return;
      }
      await state.joinRoom(
        takeover ? { takeover: true } : undefined,
      );
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "Room is already open in another tab"
      )
        return;
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
      )
        return;
      console.error("Unable to join room", error);
      toast.error(
        userErrorMessage(error, "errors.connection_failed"),
      );
    } finally {
      setBusy(false);
    }
  };
  return {
    join: () => connect(false),
    edit: () => connect(true),
    takeover: () => connect(false, true),
    busy: () =>
      busy() ||
      appState.session.clientServiceStatus === "connecting",
  };
}
