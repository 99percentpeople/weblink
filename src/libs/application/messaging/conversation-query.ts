import type {
  Conversation,
  ConversationLabel,
} from "@/libs/domain/conversation";
import { directConversationId } from "@/libs/domain/conversation";
import type { Client } from "@/libs/domain/client";
import type { StoreMessage } from "@/libs/domain/message";

export interface ConversationSummary {
  conversation: Conversation;
  title: string;
  avatar?: string;
  lastMessage?: StoreMessage;
  preview: string;
  unread: number;
  online: boolean;
  active: boolean;
}

export type ConversationFilter =
  | "all"
  | "unread"
  | "direct"
  | "room";

/** Build summaries in one pass over history instead of scanning it per row. */
export function summarizeConversations(
  conversations: readonly Conversation[],
  clients: readonly Client[],
  messages: readonly StoreMessage[],
  self: string,
  onlinePeerIds: ReadonlySet<string>,
  activeRoomId: string | null,
): ConversationSummary[] {
  const clientsById = new Map(
    clients.map((client) => [client.clientId, client]),
  );
  const histories = new Map<string, StoreMessage[]>();
  for (const message of messages) {
    const id =
      message.conversationId ??
      directConversationId(message.client, message.target);
    const history = histories.get(id);
    if (history) history.push(message);
    else histories.set(id, [message]);
  }
  return conversations
    .map((conversation) => {
      const client =
        conversation.kind === "direct"
          ? clientsById.get(conversation.peerId)
          : undefined;
      const history = histories.get(conversation.id) ?? [];
      const cursor = conversation.lastReadMessageId
        ? history.findIndex(
            (message) =>
              message.id === conversation.lastReadMessageId,
          )
        : -1;
      const unread = history
        .slice(cursor + 1)
        .filter((message) => {
          const incoming =
            conversation.kind === "direct"
              ? message.client === conversation.peerId
              : message.client !== self;
          if (!incoming) return false;
          if (cursor >= 0) return true;
          if (
            conversation.lastReadSequence !== undefined &&
            message.localSequence !== undefined
          ) {
            return (
              message.localSequence >
              conversation.lastReadSequence
            );
          }
          return (
            !conversation.lastReadAt ||
            message.createdAt > conversation.lastReadAt
          );
        }).length;
      const lastMessage = history.at(-1);
      return {
        conversation,
        title: client?.name ?? conversation.title,
        avatar: client?.avatar ?? undefined,
        lastMessage,
        preview:
          lastMessage?.type === "text"
            ? lastMessage.data
            : lastMessage?.type === "file"
              ? lastMessage.fileName
              : "",
        unread,
        online:
          conversation.kind === "direct"
            ? onlinePeerIds.has(conversation.peerId)
            : conversation.id === activeRoomId,
        active: conversation.id === activeRoomId,
      };
    })
    .sort((a, b) => {
      const active = Number(b.active) - Number(a.active);
      if (active) return active;
      if (a.lastMessage && b.lastMessage) {
        const activity =
          a.lastMessage.localSequence !== undefined &&
          b.lastMessage.localSequence !== undefined
            ? b.lastMessage.localSequence -
              a.lastMessage.localSequence
            : b.lastMessage.createdAt -
              a.lastMessage.createdAt;
        if (activity) return activity;
      } else if (a.lastMessage || b.lastMessage)
        return a.lastMessage ? -1 : 1;
      else if (
        a.conversation.createdAt !==
        b.conversation.createdAt
      )
        return (
          b.conversation.createdAt -
          a.conversation.createdAt
        );
      return a.conversation.id.localeCompare(
        b.conversation.id,
      );
    });
}

export function filterConversations(
  summaries: readonly ConversationSummary[],
  query: string,
  selectedLabelIds: readonly string[],
  filter: ConversationFilter,
  labels: readonly ConversationLabel[],
): ConversationSummary[] {
  const normalized = query
    .trim()
    .normalize("NFKC")
    .toLocaleLowerCase();
  const names = new Map(
    labels.map((label) => [label.id, label.name]),
  );
  return summaries.filter((summary) => {
    const conversation = summary.conversation;
    if (filter === "unread" && !summary.unread)
      return false;
    if (
      (filter === "direct" || filter === "room") &&
      conversation.kind !== filter
    )
      return false;
    if (
      selectedLabelIds.length &&
      !selectedLabelIds.some((id) =>
        conversation.labelIds.includes(id),
      )
    )
      return false;
    const text = [
      summary.title,
      summary.preview,
      conversation.kind === "room"
        ? conversation.roomId
        : conversation.peerId,
      ...conversation.labelIds.map(
        (id) => names.get(id) ?? "",
      ),
    ]
      .join(" ")
      .normalize("NFKC")
      .toLocaleLowerCase();
    return !normalized || text.includes(normalized);
  });
}

export function groupConversations(
  summaries: readonly ConversationSummary[],
  labels: readonly ConversationLabel[],
): {
  id: string;
  name: string;
  items: ConversationSummary[];
}[] {
  const groups = labels.map((label) => ({
    id: label.id,
    name: label.name,
    items: summaries.filter((summary) =>
      summary.conversation.labelIds.includes(label.id),
    ),
  }));
  const knownIds = new Set(labels.map((label) => label.id));
  groups.push({
    id: "unlabelled",
    name: "",
    items: summaries.filter(
      (summary) =>
        !summary.conversation.labelIds.some((id) =>
          knownIds.has(id),
        ),
    ),
  });
  return groups.filter((group) => group.items.length > 0);
}
