import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type { StoreMessage } from "@/libs/domain/message";
import type { MessageID } from "@/libs/domain/protocol/messages";
import type {
  Conversation,
  ConversationLabel,
} from "@/libs/domain/conversation";

export type MessageRepositorySnapshot = {
  messages: StoreMessage[];
  clients: Client[];
  conversations?: Conversation[];
  labels?: ConversationLabel[];
  /** Set only while importing a database that predates conversation metadata. */
  importLegacyClients?: boolean;
};

/**
 * Accepts live (including reactive) models. Writes capture detached persistent
 * values synchronously, before yielding; later caller mutations cannot change
 * the record. Reads return independent values. Adapters own serialization.
 */
export interface MessageRepository {
  load(): Promise<MessageRepositorySnapshot>;
  putMessage(message: StoreMessage): Promise<void>;
  removeMessage(messageId: MessageID): Promise<void>;
  removeMessages(messageIds: MessageID[]): Promise<void>;
  putClient(client: Client): Promise<void>;
  removeClient(clientId: ClientID): Promise<void>;
  putConversation?(
    conversation: Conversation,
  ): Promise<void>;
  removeConversation?(
    conversationId: string,
  ): Promise<void>;
  putLabel?(label: ConversationLabel): Promise<void>;
  removeLabel?(labelId: string): Promise<void>;
  close?(): void;
}
