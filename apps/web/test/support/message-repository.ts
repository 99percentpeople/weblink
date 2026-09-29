import { vi } from "vitest";
import type {
  MessageRepository,
  MessageRepositorySnapshot,
} from "@/libs/application/messaging/message-repository";
import type { Client } from "@/libs/domain/client";
import type {
  Conversation,
  ConversationLabel,
} from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";
import {
  clientRecord,
  conversationRecord,
  labelRecord,
  messageRecord,
} from "@/libs/infrastructure/storage/message-record";

/** In-memory repository with the same cloning boundary as IndexedDB.
 * Overrides are reserved for explicit failure/delay/legacy-load injection.
 */
export function createMessageRepository(
  overrides: Partial<MessageRepository> = {},
  initial: MessageRepositorySnapshot = {
    messages: [],
    clients: [],
    conversations: [],
    labels: [],
  },
) {
  const messages = new Map<string, StoreMessage>();
  const clients = new Map<string, Client>();
  const conversations = new Map<string, Conversation>();
  const labels = new Map<string, ConversationLabel>();
  let importLegacyClients =
    initial.importLegacyClients ?? false;
  for (const message of initial.messages)
    messages.set(
      message.id,
      structuredClone(messageRecord(message)),
    );
  for (const client of initial.clients)
    clients.set(
      client.clientId,
      structuredClone(clientRecord(client)),
    );
  for (const conversation of initial.conversations ?? [])
    conversations.set(
      conversation.id,
      structuredClone(conversationRecord(conversation)),
    );
  for (const label of initial.labels ?? [])
    labels.set(
      label.id,
      structuredClone(labelRecord(label)),
    );

  const repo = {
    records: { messages, clients, conversations, labels },
    load: vi.fn(
      async (): Promise<MessageRepositorySnapshot> =>
        structuredClone({
          messages: [...messages.values()].sort(
            (a, b) =>
              (a.localSequence ?? a.createdAt) -
              (b.localSequence ?? b.createdAt),
          ),
          clients: [...clients.values()],
          conversations: [...conversations.values()],
          labels: [...labels.values()],
          importLegacyClients,
        }),
    ),
    putMessage: vi.fn(async (message: StoreMessage) => {
      messages.set(
        message.id,
        structuredClone(messageRecord(message)),
      );
    }),
    putClient: vi.fn(async (client: Client) => {
      clients.set(
        client.clientId,
        structuredClone(clientRecord(client)),
      );
    }),
    putConversation: vi.fn(
      async (conversation: Conversation) => {
        conversations.set(
          conversation.id,
          structuredClone(conversationRecord(conversation)),
        );
        importLegacyClients = false;
      },
    ),
    putLabel: vi.fn(async (label: ConversationLabel) => {
      labels.set(
        label.id,
        structuredClone(labelRecord(label)),
      );
    }),
    removeMessage: vi.fn(async (id: string) => {
      messages.delete(id);
    }),
    removeMessages: vi.fn(async (ids: string[]) => {
      ids.forEach((id) => messages.delete(id));
    }),
    removeClient: vi.fn(async (id: string) => {
      clients.delete(id);
    }),
    removeConversation: vi.fn(async (id: string) => {
      conversations.delete(id);
      for (const message of messages.values())
        if (message.conversationId === id)
          messages.delete(message.id);
    }),
    removeLabel: vi.fn(async (id: string) => {
      labels.delete(id);
      for (const conversation of conversations.values())
        conversation.labelIds =
          conversation.labelIds.filter(
            (label) => label !== id,
          );
    }),
  } satisfies MessageRepository & { records: unknown };
  return Object.assign(repo, overrides);
}
