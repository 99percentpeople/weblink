import { userErrorMessage } from "@/libs/user-error";
import { createSignal } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import type { createRoomDialog } from "@/components/dialogs/join-dialog";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { MessageStores } from "@/libs/application/messaging/message-store";
import { getRoomJoinHistory } from "@/libs/application/messaging/room-join-history";

export function createRoomActions({
  state,
  dialog,
  history,
  namespace,
}: {
  state: Pick<AppStateContextProps, "joinRoom">;
  dialog: Pick<ReturnType<typeof createRoomDialog>, "open">;
  history: Pick<
    MessageStores,
    "initialize" | "conversations"
  >;
  namespace: string;
}) {
  const [busy, setBusy] = createSignal(false);
  const available = () =>
    !busy() &&
    appState.session.clientServiceStatus === "disconnected";
  const requireConfiguration = () =>
    toast.error(
      t("common.join_form.configure_before_join"),
    );
  const isCancelledJoin = (error: unknown) =>
    (error instanceof Error &&
      error.message ===
        "Room is already open in another tab") ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AbortError");
  const reportError = (error: unknown) => {
    console.error("Unable to join room", error);
    toast.error(
      userErrorMessage(error, "errors.connection_failed"),
    );
  };
  const connect = async (
    mode: "recent" | "configured" | "edit" | "takeover",
  ) => {
    if (!available()) return;
    setBusy(true);
    try {
      if (mode === "recent" || mode === "edit") {
        await history.initialize();
        if (
          appState.session.clientServiceStatus !==
          "disconnected"
        )
          return;
      }
      if (mode === "recent") {
        const room = getRoomJoinHistory(
          history.conversations,
          namespace,
        )[0];
        if (room) {
          // Legacy entries can only reuse credentials for the same room.
          if (
            room.joinPassword === undefined &&
            room.roomId !== appState.profile.roomId.trim()
          ) {
            requireConfiguration();
            return;
          }
          setAppState("profile", {
            roomId: room.roomId,
            password:
              room.joinPassword !== undefined
                ? room.joinPassword
                : appState.profile.password,
            initalJoin: false,
          });
        } else if (
          history.conversations.some(
            (item) => item.kind === "room",
          )
        ) {
          // Do not restore removed shortcuts or rooms belonging to another server.
          requireConfiguration();
          return;
        }
      }
      if (
        mode !== "edit" &&
        mode !== "takeover" &&
        (appState.profile.initalJoin ||
          !appState.profile.name.trim() ||
          !appState.profile.roomId.trim())
      ) {
        requireConfiguration();
        return;
      }
      let retry = false;
      while (true) {
        if (mode === "edit") {
          const result = retry
            ? await dialog.open({ retry: true })
            : await dialog.open();
          if (result.cancel) return;
        }
        const newRoom =
          mode === "edit" &&
          !getRoomJoinHistory(
            history.conversations,
            namespace,
          ).some(
            (room) =>
              room.roomId ===
              appState.profile.roomId.trim(),
          );
        try {
          await state.joinRoom(
            mode === "takeover"
              ? { takeover: true }
              : undefined,
          );
          return;
        } catch (error) {
          if (
            !newRoom ||
            isCancelledJoin(error) ||
            appState.session.clientServiceStatus !==
              "disconnected"
          )
            throw error;
          reportError(error);
          retry = true;
        }
      }
    } catch (error) {
      if (!isCancelledJoin(error)) reportError(error);
    } finally {
      setBusy(false);
    }
  };
  return {
    join: () => connect("recent"),
    autoJoin: () => connect("configured"),
    edit: () => connect("edit"),
    takeover: () => connect("takeover"),
    busy: () =>
      busy() ||
      appState.session.clientServiceStatus === "connecting",
  };
}
