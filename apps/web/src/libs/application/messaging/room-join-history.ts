import type {
  Conversation,
  RoomConversation,
} from "@/libs/domain/conversation";

export function getRoomJoinHistory(
  conversations: readonly Conversation[],
  namespace: string,
): RoomConversation[] {
  return conversations
    .filter(
      (room): room is RoomConversation =>
        room.kind === "room" &&
        room.namespace === namespace &&
        !room.joinHistoryHidden,
    )
    .sort(
      (a, b) =>
        (b.lastJoinedAt ?? b.createdAt) -
        (a.lastJoinedAt ?? a.createdAt),
    );
}
