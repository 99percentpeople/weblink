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
import { RoomMessageStore } from "./room-message-store";
import { snapshotStoreMessage } from "./message-snapshot";
import {
  applyTrackedResponse,
  projectIncomingMessage,
  projectOutgoingMessage,
  projectRetry,
} from "./message-projection";

function snapshotClient(client: Client): Client {
  return { ...client };
}

export class MessageStores {
  readonly messages: StoreMessage[] =
    appState.message.messages;
  readonly clients: Client[] = appState.message.clients;
  readonly conversations = appState.message.conversations;
  readonly labels = appState.message.labels;

  private readonly metadata: ConversationStore;
  private readonly roomMessages: RoomMessageStore;

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
    this.roomMessages = new RoomMessageStore(repository, {
      conversations: this.conversations,
      messages: this.messages,
      initialize: () => this.initialize(),
      withLocalSequence: (message) =>
        this.withLocalSequence(message),
      setMessages: this.setMessages,
    });
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
            let projected = this.metadata.attach(message);
            // There is no background outbox: a reload retires any in-flight
            // delivery, so expose it as retryable instead of sending forever.
            if (
              projected.room &&
              projected.deliveries &&
              Object.values(projected.deliveries).includes(
                "sending",
              )
            ) {
              projected = {
                ...projected,
                deliveries: Object.fromEntries(
                  Object.entries(projected.deliveries).map(
                    ([peer, status]) => [
                      peer,
                      status === "sending"
                        ? "failed"
                        : status,
                    ],
                  ),
                ),
              } as RoomMessage;
            }
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
              (!!message.room &&
                message !== messages[index])
                ? this.repository.putMessage(
                    snapshotStoreMessage(message),
                  )
                : Promise.resolve(),
            ),
          );
          await Promise.all(
            this.conversations.map((conversation) =>
              this.repository.putConversation?.(
                this.metadata.snapshot(conversation),
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
                    } satisfies FileTransferMessage;
                  }
                  return message;
                }),
            ),
          );
          setAppState("message", "status", "ready");
        },
      );

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
  putRoomMessage(message: RoomMessage): Promise<boolean> {
    return this.roomMessages.putRoomMessage(message);
  }
  setRoomDelivery(
    messageId: string,
    peerId: string,
    status: RoomDeliveryStatus,
  ): Promise<void> {
    return this.roomMessages.setRoomDelivery(
      messageId,
      peerId,
      status,
    );
  }
  deleteConversation(id: string): void {
    this.roomMessages.invalidateConversation(id);
    this.metadata.deleteConversation(id);
  }
  clearConversation(id: string): void {
    this.roomMessages.invalidateConversation(id);
    this.metadata.clearConversation(id);
  }

  private persistMessage(message: StoreMessage): void {
    if (message.room) {
      void this.roomMessages
        .persistCurrentRoomMessage(message.id)
        .catch((error) => {
          console.error(
            "[MessageStore] could not persist room message",
            error,
          );
        });
      return;
    }
    const snapshot = snapshotStoreMessage(message);
    void this.repository
      .putMessage(snapshot)
      .then(() => {
        if (
          !this.messages.some(
            (item) => item.id === snapshot.id,
          )
        )
          return this.repository.removeMessage(snapshot.id);
      })
      .catch((error) => {
        console.error(
          "[MessageStore] could not persist message",
          error,
        );
      });
  }

  private persistClient(client: Client): void {
    const snapshot = snapshotClient(client);
    void this.repository
      .putClient(snapshot)
      .catch((error) => {
        console.error(
          "[MessageStore] could not persist client",
          error,
        );
      });
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

  setSendMessage(sessionMsg: SessionMessage): void {
    if (
      this.messages.some(
        (message) => message.id === sessionMsg.id,
      )
    ) {
      return;
    }

    const projected = projectOutgoingMessage(sessionMsg);
    if (!projected) return;
    const message = this.metadata.attach(projected);

    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    this.persistMessage(message);
  }

  retrySendMessage(sessionMsg: SessionMessage): void {
    const index = this.messages.findLastIndex(
      (message) => message.id === sessionMsg.id,
    );

    if (index === -1) {
      this.setSendMessage(sessionMsg);
      return;
    }

    if (this.messages[index].room) return;

    const message = projectRetry(
      this.messages[index],
      sessionMsg,
    );
    if (!message) return;

    this.setMessages(index, reconcile(message));
    this.persistMessage(message);
  }

  setReceiveMessage(sessionMsg: SessionMessage): void {
    const index = this.messages.findIndex(
      (message) => message.id === sessionMsg.id,
    );
    const current = this.messages[index];
    // Room receipts are tracked per recipient; a legacy private response
    // sharing an id must never mutate a room's logical message.
    if (current?.room) return;

    if (
      sessionMsg.type === "ack" ||
      sessionMsg.type === "error"
    ) {
      if (index === -1) return;
      const message = applyTrackedResponse(
        this.messages[index],
        sessionMsg,
      );
      if (!message) return;
      this.setMessages(index, reconcile(message));
      this.persistMessage(message);
      return;
    }

    if (index !== -1) {
      // Preserve historical duplicate semantics: repeated text/file setup clears
      // a stale local error, while repeated request-file does not mutate history.
      if (
        sessionMsg.type === "send-text" ||
        sessionMsg.type === "send-file"
      ) {
        const message = {
          ...this.messages[index],
          error: undefined,
        } as StoreMessage;
        this.setMessages(index, reconcile(message));
        this.persistMessage(message);
      }
      return;
    }

    const projected = projectIncomingMessage(sessionMsg);
    if (!projected) return;
    const message = this.metadata.attach(projected);

    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    this.persistMessage(message);
  }

  async addMessage(message: StoreMessage): Promise<void> {
    message = this.metadata.attach(message);
    this.setMessages(
      produce((state) => {
        state.push(message);
      }),
    );
    await this.repository.putMessage(
      snapshotStoreMessage(message),
    );
    if (
      !this.messages.some((item) => item.id === message.id)
    )
      await this.repository.removeMessage(message.id);
  }

  setClient(client: Client): void {
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
    this.persistClient(client);
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
