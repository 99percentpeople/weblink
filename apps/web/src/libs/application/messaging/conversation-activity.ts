import {
  directConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";

/** Both lists use the same fallback for records saved before updatedAt existed. */
export function getConversationUpdateTimes(
  conversations: readonly Conversation[],
  messages: readonly StoreMessage[],
): Map<string, number> {
  const times = new Map<string, number>();
  const legacy = new Set<string>();
  for (const conversation of conversations) {
    times.set(
      conversation.id,
      conversation.updatedAt ??
        Math.max(
          conversation.createdAt,
          conversation.kind === "room"
            ? (conversation.lastJoinedAt ?? 0)
            : 0,
        ),
    );
    if (conversation.updatedAt === undefined)
      legacy.add(conversation.id);
  }
  for (const message of messages) {
    const id =
      message.conversationId ??
      directConversationId(message.client, message.target);
    if (legacy.has(id))
      times.set(
        id,
        Math.max(times.get(id) ?? 0, message.createdAt),
      );
  }
  return times;
}
