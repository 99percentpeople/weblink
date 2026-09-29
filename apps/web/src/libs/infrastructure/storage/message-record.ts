import type { Client } from "@/libs/domain/client";
import type {
  Conversation,
  ConversationLabel,
} from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";
import { snapshotStoreMessage } from "@/libs/application/messaging/message-snapshot";

/** Capture model values before any asynchronous storage work. */
export function conversationRecord(
  conversation: Conversation,
): Conversation {
  return {
    ...conversation,
    labelIds: [...conversation.labelIds],
    ...(conversation.kind === "direct" &&
    conversation.roomConversationIds
      ? {
          roomConversationIds: [
            ...conversation.roomConversationIds,
          ],
        }
      : {}),
  };
}

export function messageRecord(
  message: StoreMessage,
): StoreMessage {
  const snapshot = snapshotStoreMessage(message);
  if (snapshot.type !== "file") return snapshot;
  // Aggregate transfer progress and local import jobs are transient. Keep
  // recipient transfer outcomes for room history and interrupted-send recovery.
  const {
    progress,
    localContentPending,
    localContentDetached,
    ...record
  } = snapshot;
  return record;
}

export function clientRecord(client: Client): Client {
  return { ...client };
}

export function labelRecord(
  label: ConversationLabel,
): ConversationLabel {
  return { ...label };
}
