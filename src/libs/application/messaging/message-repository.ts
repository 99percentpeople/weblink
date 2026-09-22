import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type { StoreMessage } from "@/libs/domain/message";
import type { MessageID } from "@/libs/domain/protocol/messages";

export type MessageRepositorySnapshot = {
  messages: StoreMessage[];
  clients: Client[];
};

export interface MessageRepository {
  load(): Promise<MessageRepositorySnapshot>;
  putMessage(message: StoreMessage): Promise<void>;
  removeMessage(messageId: MessageID): Promise<void>;
  removeMessages(messageIds: MessageID[]): Promise<void>;
  putClient(client: Client): Promise<void>;
  removeClient(clientId: ClientID): Promise<void>;
  close?(): void;
}
