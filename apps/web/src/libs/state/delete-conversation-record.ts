import { batch } from "solid-js";
import { messageStores } from "@/libs/application/messaging/message-store";
import { getRoomNamespace } from "@/libs/application/room-identity";
import { appState, setAppState } from "./app-state";
import { forgetRoomConfig } from "./permission-options";
import { roomConversationId } from "@/libs/domain/conversation";

/** Called after the UI confirms deletion and verifies the room is inactive. */
export function deleteConversationRecord(id: string): void {
  const conversation = appState.message.conversations.find(
    (item) => item.id === id,
  );
  if (!conversation) return;
  if (conversation.kind === "room") deleteRoomRecord(id);
  else messageStores.deleteConversation(id);
}

/** Also removes permissions-only history after conversation hydration completes. */
export function deleteRoomRecord(id: string): void {
  batch(() => {
    messageStores.deleteConversation(id);
    forgetRoomConfig(id, undefined);
    if (
      roomConversationId(
        getRoomNamespace(),
        appState.profile.roomId.trim(),
      ) === id
    ) {
      setAppState("profile", {
        roomId: "",
        password: null,
      });
    }
  });
}
