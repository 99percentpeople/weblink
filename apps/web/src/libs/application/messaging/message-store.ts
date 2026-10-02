import {
  produce,
  reconcile,
  SetStoreFunction,
} from "solid-js/store";
import type { Accessor } from "solid-js";
import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type {
  FileTransferMessage,
  StoreMessage,
  RoomMessage,
  RoomDeliveryStatus,
} from "@/libs/domain/message";
import {
  directConversationId,
  type Conversation,
  type ConversationLabel,
} from "@/libs/domain/conversation";
export type {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
  RoomMessage,
  RoomFileTransferState,
} from "@/libs/domain/message";
import type {
  MessageID,
  SessionMessage,
} from "@/libs/domain/protocol/messages";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { MessageRepository } from "./message-repository";
import { ConversationStore } from "./conversation-store";
import { ConversationMessageStore } from "./conversation-message-store";
import { recoverMessageDelivery } from "./message-delivery";
import {
  applyTrackedResponse,
  projectIncomingMessage,
  projectOutgoingMessage,
  projectRetry,
} from "./message-projection";

export class MessageStores {
  private readonly storedListeners = new Set<
    (message: StoreMessage) => void
  >();
  onMessageStored(
    listener: (message: StoreMessage) => void,
  ): () => void {
    this.storedListeners.add(listener);
    return () => {
      this.storedListeners.delete(listener);
    };
  }
  readonly messages: StoreMessage[] =
    appState.message.messages;
  readonly clients: Client[] = appState.message.clients;
  readonly conversations = appState.message.conversations;
  readonly labels = appState.message.labels;

  private readonly metadata: ConversationStore;
  private readonly durableMessages: ConversationMessageStore;

  private setMessages: SetStoreFunction<StoreMessage[]> = ((
    ...args: any[]
  ) =>
    (setAppState as any)(
      "message",
      "messages",
      ...args,
    )) as any;

  private setClients: SetStoreFunction<Client[]> = ((
    ...args: any[]
  ) =>
    (setAppState as any)(
      "message",
      "clients",
      ...args,
    )) as any;

  status: Accessor<"initializing" | "ready"> = () =>
    appState.message.status;

  private initialization: Promise<void> | null = null;
  private hydrated = false;
  private lastSequence = 0;

  constructor(
    private readonly repository: MessageRepository,
  ) {
    this.metadata = new ConversationStore(repository, {
      conversations: this.conversations,
      labels: this.labels,
      clients: this.clients,
      messages: this.messages,
      localClientId: () => appState.profile.clientId,
      withLocalSequence: (message) =>
        this.withLocalSequence(message),
      setConversations: ((...args: any[]) =>
        (setAppState as any)(
          "message",
          "conversations",
          ...args,
        )) as SetStoreFunction<Conversation[]>,
      setLabels: ((...args: any[]) =>
        (setAppState as any)(
          "message",
          "labels",
          ...args,
        )) as SetStoreFunction<ConversationLabel[]>,
      setMessages: this.setMessages,
      removeMessages: (ids) =>
        this.removePersistedMessages(ids),
    });
    this.durableMessages = new ConversationMessageStore(
      repository,
      {
        onStored: (message) => {
          for (const listener of this.storedListeners) {
            try {
              listener(message);
            } catch (error) {
              console.warn(
                "Message notification failed",
                error,
              );
            }
          }
        },
        conversations: this.conversations,
        messages: this.messages,
        initialize: () => this.initialize(),
        attach: (message) => this.metadata.attach(message),
        withLocalSequence: (message) =>
          this.withLocalSequence(message),
        setMessages: this.setMessages,
      },
    );
  }

  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;

    this.initialization = this.repository
      .load()
      .then(
        async ({
          messages,
          clients,
          conversations: storedConversations,
          labels = [],
          importLegacyClients = storedConversations ===
            undefined,
        }) => {
          const conversations = storedConversations ?? [];
          this.lastSequence = messages.reduce(
            (maximum, message) =>
              Math.max(maximum, message.localSequence ?? 0),
            0,
          );
          this.lastSequence = conversations.reduce(
            (maximum, conversation) =>
              Math.max(
                maximum,
                conversation.lastReadSequence ?? 0,
              ),
            this.lastSequence,
          );
          this.setClients(reconcile(clients));
          setAppState(
            "message",
            "conversations",
            reconcile(conversations),
          );
          setAppState(
            "message",
            "labels",
            reconcile(labels),
          );
          const normalized = messages.map((message) => {
            let projected = recoverMessageDelivery(
              this.metadata.attach(message),
            );
            if (
              projected.type === "file" &&
              projected.room &&
              projected.roomTransfers &&
              Object.values(projected.roomTransfers).some(
                (transfer) =>
                  transfer.status === "init" ||
                  transfer.status === "transfering",
              )
            ) {
              projected = {
                ...projected,
                roomTransfers: Object.fromEntries(
                  Object.entries(
                    projected.roomTransfers,
                  ).map(([peer, transfer]) => [
                    peer,
                    {
                      ...transfer,
                      status:
                        transfer.status === "init" ||
                        transfer.status === "transfering"
                          ? "paused"
                          : transfer.status,
                    },
                  ]),
                ),
              };
            }
            return projected;
          });
          // Persist imports before declaring hydration complete. Future loads no
          // longer need to infer which conversation owns a historical message.
          if (importLegacyClients) {
            for (const client of clients)
              this.ensureDirectConversation(
                client.clientId,
              );
          }
          this.metadata.restoreReadingPositions(normalized);
          await Promise.all(
            normalized.map((message, index) =>
              message.conversationId !==
                messages[index].conversationId ||
              message.localSequence !==
                messages[index].localSequence ||
              message.status !== messages[index].status ||
              message.deliveries !==
                messages[index].deliveries ||
              (!!message.room &&
                message !== messages[index])
                ? this.repository.putMessage(message)
                : Promise.resolve(),
            ),
          );
          await Promise.all(
            this.conversations.map((conversation) =>
              this.repository.putConversation?.(
                conversation,
              ),
            ),
          );
          this.setMessages(
            reconcile(
              normalized
                .sort(
                  (a, b) =>
                    a.localSequence! - b.localSequence!,
                )
                .map((message) => {
                  if (
                    message.type === "file" &&
                    (!message.room ||
                      message.transferStatus !==
                        undefined) &&
                    message.transferStatus !== "complete"
                  ) {
                    return {
                      ...message,
                      transferStatus: "paused",
                      localContentPending: false,
                      localContentDetached: false,
                    } satisfies FileTransferMessage;
                  }
                  return message;
                }),
            ),
          );
          this.hydrated = true;
          setAppState("message", "status", "ready");
        },
      )
      .catch((error) => {
        this.initialization = null;
        this.hydrated = false;
        throw error;
      });

    return this.initialization;
  }

  private withLocalSequence<T extends StoreMessage>(
    message: T,
  ): T {
    if (message.localSequence !== undefined) {
      this.lastSequence = Math.max(
        this.lastSequence,
        message.localSequence,
      );
      return message;
    }
    return {
      ...message,
      localSequence: ++this.lastSequence,
    };
  }

  ensureDirectConversation(peerId: string): Conversation {
    return this.metadata.ensureDirectConversation(peerId);
  }
  ensureRoomConversation(
    roomId: string,
    namespace: string,
  ): Conversation {
    return this.metadata.ensureRoomConversation(
      roomId,
      namespace,
    );
  }
  recordRoomMember(
    roomConversationId: string,
    peerId: string,
  ): void {
    this.metadata.recordRoomMember(
      roomConversationId,
      peerId,
    );
  }
  getConversationMessages(id: string): StoreMessage[] {
    return this.metadata.getConversationMessages(id);
  }
  markConversationRead(id: string): void {
    this.metadata.markConversationRead(id);
  }
  createLabel(name: string): ConversationLabel {
    return this.metadata.createLabel(name);
  }
  renameLabel(id: string, name: string): void {
    this.metadata.renameLabel(id, name);
  }
  deleteLabel(id: string): void {
    this.metadata.deleteLabel(id);
  }
  setConversationLabels(
    id: string,
    labelIds: string[],
  ): void {
    this.metadata.setConversationLabels(id, labelIds);
  }
  async putRoomMessage(
    message: RoomMessage,
  ): Promise<boolean> {
    if (!message.room)
      throw new Error(
        "Room message is missing room identity",
      );
    return this.durableMessages.putMessage(message);
  }
  setRoomDelivery(
    messageId: string,
    peerId: string,
    status: RoomDeliveryStatus,
  ): Promise<void> {
    return this.durableMessages.setDelivery(
      messageId,
      peerId,
      status,
    );
  }
  deleteConversation(id: string): void {
    this.durableMessages.invalidateConversation(id);
    this.metadata.deleteConversation(id);
  }
  clearConversation(id: string): void {
    this.durableMessages.invalidateConversation(id);
    this.metadata.clearConversation(id);
  }

  private persistMessage(message: StoreMessage): void {
    void this.durableMessages
      .persistCurrentMessage(message.id)
      .catch((error) => {
        console.error(
          "[MessageStore] could not persist message",
          error,
        );
      });
  }

  private persistClient(client: Client): Promise<void> {
    const persisted = this.repository.putClient(client);
    void persisted.catch((error) => {
      console.error(
        "[MessageStore] could not persist client",
        error,
      );
    });
    return persisted;
  }

  private removePersistedMessage(
    messageId: MessageID,
  ): void {
    void this.repository
      .removeMessage(messageId)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete message",
          error,
        );
      });
  }

  private removePersistedMessages(
    messageIds: MessageID[],
  ): void {
    void this.repository
      .removeMessages(messageIds)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete messages",
          error,
        );
      });
  }

  private removePersistedClient(clientId: ClientID): void {
    void this.repository
      .removeClient(clientId)
      .catch((error) => {
        console.error(
          "[MessageStore] could not delete client",
          error,
        );
      });
  }

  async setSendMessage(
    sessionMsg: SessionMessage,
  ): Promise<void> {
    const message = projectOutgoingMessage(sessionMsg);
    if (message)
      await this.durableMessages.putMessage(
        message,
        sessionMsg.type === "request-file",
      );
  }

  async retrySendMessage(
    sessionMsg: SessionMessage,
  ): Promise<void> {
    await this.initialize();
    const current = this.messages.find(
      (message) => message.id === sessionMsg.id,
    );
    if (!current) throw new Error("Message was removed");
    if (current.room) return;
    const incoming = projectOutgoingMessage(sessionMsg);
    if (!incoming) return;
    this.durableMessages.assertSameMessage(
      current,
      incoming,
      sessionMsg.type === "request-file",
    );
    await this.durableMessages.update(
      current.id,
      (message) => {
        const retry = projectRetry(message, sessionMsg);
        if (!retry) return null;
        return {
          status: retry.status,
          error: undefined,
          deliveries: { [sessionMsg.target]: "sending" },
          ...(retry.type === "file" &&
          sessionMsg.type === "request-file"
            ? { transferStatus: retry.transferStatus }
            : {}),
        };
      },
    );
  }

  async setReceiveMessage(
    sessionMsg: SessionMessage,
  ): Promise<void> {
    // A private receipt must never mutate a room message with the same ID.
    if (
      sessionMsg.type === "ack" ||
      sessionMsg.type === "error"
    ) {
      await this.initialize();
      const current = this.messages.find(
        (message) => message.id === sessionMsg.id,
      );
      if (!current || current.room) return;
      await this.durableMessages.update(
        current.id,
        (message) => {
          const response = applyTrackedResponse(
            message,
            sessionMsg,
          );
          return response
            ? {
                status: response.status,
                error: response.error,
                deliveries: response.deliveries,
              }
            : null;
        },
      );
      return;
    }
    const incoming = projectIncomingMessage(sessionMsg);
    if (incoming)
      await this.durableMessages.putMessage(
        incoming,
        sessionMsg.type === "request-file",
      );
  }

  /** Receipts and progress share the same ordered persistence boundary. */
  async flushMessage(id: string): Promise<void> {
    await this.initialize();
    await this.durableMessages.persistCurrentMessage(id);
  }

  async addMessage(message: StoreMessage): Promise<void> {
    if (!this.hydrated) await this.initialize();
    await this.durableMessages.putMessage({
      ...message,
      conversationId:
        message.conversationId ??
        directConversationId(
          message.client,
          message.target,
        ),
    });
  }

  getClient(clientId: ClientID): Client | undefined {
    return this.clients.find(
      (client) => client.clientId === clientId,
    );
  }

  setClient(client: Client): Promise<void> {
    if (!this.hydrated) {
      // Capture this request before waiting for initial hydration.
      const snapshot = { ...client };
      const pending = this.initialize().then(() =>
        this.setClient(snapshot),
      );
      void pending.catch((error) => {
        console.error(
          "[MessageStore] could not cache client after hydration",
          error,
        );
      });
      return pending;
    }
    const index = this.clients.findIndex(
      (candidate) => candidate.clientId === client.clientId,
    );
    if (index !== -1) {
      this.setClients(index, client);
    } else {
      this.setClients(
        produce((state) => state.push(client)),
      );
    }
    const persisted = this.persistClient(client);
    for (
      let index = 0;
      index < this.conversations.length;
      index++
    ) {
      const conversation = this.conversations[index];
      if (
        conversation.kind === "direct" &&
        conversation.peerId === client.clientId
      ) {
        setAppState(
          "message",
          "conversations",
          index,
          "title",
          client.name,
        );
        this.metadata.persist(this.conversations[index]);
      }
    }
    this.ensureDirectConversation(client.clientId);
    return persisted;
  }

  deleteClient(clientId: ClientID): void {
    const index = this.clients.findIndex(
      (client) => client.clientId === clientId,
    );
    if (index !== -1) {
      this.setClients(
        produce((state) => state.splice(index, 1)),
      );
    }
    this.removePersistedClient(clientId);
    this.deleteMessagesByClient(clientId);
    for (const conversation of [...this.conversations]) {
      if (
        conversation.kind === "direct" &&
        conversation.peerId === clientId
      )
        this.deleteConversation(conversation.id);
    }
  }

  deleteMessagesByClient(clientId: ClientID): void {
    const messageDeletes = this.messages.filter(
      (message) =>
        !message.room &&
        (message.client === clientId ||
          message.target === clientId),
    );

    this.removePersistedMessages(
      messageDeletes.map((message) => message.id),
    );
    const ids = new Set(
      messageDeletes.map((message) => message.id),
    );
    this.setMessages(
      reconcile(
        this.messages.filter(
          (message) => !ids.has(message.id),
        ),
      ),
    );
  }

  updateTransferMessage(
    messageId: MessageID,
    update: (message: FileTransferMessage) => void,
  ): void {
    const index = this.messages.findIndex(
      (message) =>
        message.id === messageId && message.type === "file",
    );
    if (index === -1) return;

    this.setMessages(
      index,
      produce((message) => {
        if (message.type !== "file") return;
        update(message);
        // Completion is proof that the offer reached its sole private recipient.
        // Byte-transfer failures, however, must not undo an acknowledged offer.
        if (
          !message.room &&
          message.deliveries &&
          message.transferStatus === "complete"
        ) {
          message.deliveries = Object.fromEntries(
            Object.keys(message.deliveries).map((peer) => [
              peer,
              "delivered" as const,
            ]),
          );
          message.status = "received";
        }
      }),
    );
    this.persistMessage(this.messages[index]);
  }

  deleteMessage(messageId: MessageID): boolean {
    const index = this.messages.findIndex(
      (message) => message.id === messageId,
    );
    if (index === -1) return false;

    this.setMessages(
      produce((state) => state.splice(index, 1)),
    );
    this.removePersistedMessage(messageId);
    return true;
  }
}

export let messageStores: MessageStores;

export function createMessageStores(
  repository?: MessageRepository,
) {
  if (!messageStores) {
    if (!repository) {
      throw new Error(
        "MessageStores requires a MessageRepository on first initialization",
      );
    }
    messageStores = new MessageStores(repository);
  }
  return messageStores;
}
