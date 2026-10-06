import { createUuid } from "@/libs/domain/ids";
import {
  produce,
  reconcile,
  type SetStoreFunction,
} from "solid-js/store";
import type { Client } from "@/libs/domain/client";
import type { StoreMessage } from "@/libs/domain/message";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
  type ConversationLabel,
} from "@/libs/domain/conversation";
import type { MessageRepository } from "./message-repository";

export interface ConversationStoreDependencies {
  conversations: Conversation[];
  labels: ConversationLabel[];
  clients: Client[];
  messages: StoreMessage[];
  localClientId(): string;
  withLocalSequence<T extends StoreMessage>(message: T): T;
  setConversations: SetStoreFunction<Conversation[]>;
  setLabels: SetStoreFunction<ConversationLabel[]>;
  setMessages: SetStoreFunction<StoreMessage[]>;
  removeMessages(ids: string[]): void;
}

/** Local organization metadata; message and room transport owners are injected. */
export class ConversationStore {
  constructor(
    private readonly repository: MessageRepository,
    private readonly dependencies: ConversationStoreDependencies,
  ) {}
  private get conversations() {
    return this.dependencies.conversations;
  }
  private get labels() {
    return this.dependencies.labels;
  }
  private get clients() {
    return this.dependencies.clients;
  }
  private get messages() {
    return this.dependencies.messages;
  }

  restoreReadingPositions(
    messages: readonly StoreMessage[],
  ): void {
    const sequenceById = new Map(
      messages.map((message) => [
        message.id,
        message.localSequence,
      ]),
    );
    this.conversations.forEach((conversation, index) => {
      if (
        conversation.lastReadSequence !== undefined ||
        !conversation.lastReadMessageId
      )
        return;
      const sequence = sequenceById.get(
        conversation.lastReadMessageId,
      );
      if (sequence !== undefined)
        this.dependencies.setConversations(
          index,
          "lastReadSequence",
          sequence,
        );
    });
  }

  persist(conversation: Conversation): void {
    void this.repository
      .putConversation?.(conversation)
      .catch((error) =>
        console.error(
          "[MessageStore] could not persist conversation",
          error,
        ),
      );
  }

  attach(message: StoreMessage): StoreMessage {
    message = this.dependencies.withLocalSequence(message);
    if (message.room) return message;
    const id =
      message.conversationId ??
      directConversationId(message.client, message.target);
    if (
      !this.conversations.some(
        (conversation) => conversation.id === id,
      )
    ) {
      const localId = this.dependencies.localClientId();
      const peerId =
        message.client === localId
          ? message.target
          : message.target === localId
            ? message.client
            : this.clients.some(
                  (client) =>
                    client.clientId === message.target,
                )
              ? message.target
              : message.client;
      const conversation: Conversation = {
        id,
        kind: "direct",
        peerId,
        title:
          this.clients.find(
            (client) => client.clientId === peerId,
          )?.name ?? peerId,
        labelIds: [],
        createdAt: message.createdAt,
      };
      this.dependencies.setConversations(
        produce((state) => state.push(conversation)),
      );
      this.persist(conversation);
    }
    return { ...message, conversationId: id };
  }

  ensureDirectConversation(peerId: string): Conversation {
    const id = directConversationId(
      this.dependencies.localClientId(),
      peerId,
    );
    const existing = this.conversations.find(
      (conversation) => conversation.id === id,
    );
    if (existing) return existing;
    const conversation: Conversation = {
      id,
      kind: "direct",
      peerId,
      title:
        this.clients.find(
          (client) => client.clientId === peerId,
        )?.name ?? peerId,
      labelIds: [],
      createdAt: Date.now(),
    };
    this.dependencies.setConversations(
      produce((state) => state.push(conversation)),
    );
    this.persist(conversation);
    return this.conversations.find(
      (item) => item.id === id,
    )!;
  }

  ensureRoomConversation(
    roomId: string,
    namespace: string,
  ): Conversation {
    const id = roomConversationId(namespace, roomId);
    const existing = this.conversations.find(
      (conversation) => conversation.id === id,
    );
    if (existing) return existing;
    const conversation: Conversation = {
      id,
      kind: "room",
      roomId,
      namespace,
      title: roomId,
      labelIds: [],
      createdAt: Date.now(),
    };
    this.dependencies.setConversations(
      produce((state) => state.push(conversation)),
    );
    this.persist(conversation);
    return this.conversations.find(
      (item) => item.id === id,
    )!;
  }

  recordRoomJoin(
    roomId: string,
    namespace: string,
    password: string | null,
    joinedAt: number,
  ): void {
    const room = this.ensureRoomConversation(
      roomId,
      namespace,
    );
    const index = this.conversations.findIndex(
      (item) => item.id === room.id,
    );
    this.dependencies.setConversations(index, {
      lastJoinedAt: joinedAt,
      updatedAt: Math.max(room.updatedAt ?? 0, joinedAt),
      joinPassword: password,
      joinHistoryHidden: false,
    });
    this.persist(this.conversations[index]);
  }

  recordActivity(id: string, updatedAt: number): void {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (
      index === -1 ||
      (this.conversations[index].updatedAt ?? 0) >=
        updatedAt
    )
      return;
    this.dependencies.setConversations(
      index,
      "updatedAt",
      updatedAt,
    );
    this.persist(this.conversations[index]);
  }

  hideRoomFromJoinHistory(id: string): void {
    const index = this.conversations.findIndex(
      (item) => item.id === id && item.kind === "room",
    );
    if (index === -1) return;
    this.dependencies.setConversations(index, {
      joinHistoryHidden: true,
      joinPassword: undefined,
    });
    this.persist(this.conversations[index]);
  }

  recordRoomMember(
    roomConversationId: string,
    peerId: string,
  ): void {
    // Membership belongs to the retained private conversation. Do not recreate
    // one the user deleted merely to keep a historical member visible.
    const id = directConversationId(
      this.dependencies.localClientId(),
      peerId,
    );
    const index = this.conversations.findIndex(
      (item) => item.id === id && item.kind === "direct",
    );
    const conversation = this.conversations[index];
    if (
      conversation?.kind !== "direct" ||
      conversation.roomConversationIds?.includes(
        roomConversationId,
      )
    )
      return;
    this.dependencies.setConversations(index, {
      roomConversationIds: [
        ...(conversation.roomConversationIds ?? []),
        roomConversationId,
      ],
    });
    this.persist(this.conversations[index]);
  }

  getConversationMessages(id: string): StoreMessage[] {
    return this.messages.filter(
      (message) => message.conversationId === id,
    );
  }

  markConversationRead(id: string): void {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (index === -1) return;
    const last = this.messages.findLast(
      (message) => message.conversationId === id,
    );
    if (
      !last ||
      this.conversations[index].lastReadMessageId ===
        last.id
    )
      return;
    this.dependencies.setConversations(index, {
      lastReadMessageId: last.id,
      lastReadAt: Date.now(),
      lastReadSequence: last.localSequence,
    });
    this.persist(this.conversations[index]);
  }

  createLabel(name: string): ConversationLabel {
    const normalized = name.trim();
    if (!normalized)
      throw new Error("Label name is required");
    const existing = this.labels.find(
      (label) =>
        label.name.toLocaleLowerCase() ===
        normalized.toLocaleLowerCase(),
    );
    if (existing) return existing;
    const label: ConversationLabel = {
      id: createUuid(),
      name: normalized,
    };
    this.dependencies.setLabels(
      produce((state) => state.push(label)),
    );
    void this.repository
      .putLabel?.(label)
      .catch((error) =>
        console.error(
          "[MessageStore] could not persist label",
          error,
        ),
      );
    return label;
  }

  renameLabel(id: string, name: string): void {
    const normalized = name.trim();
    if (!normalized)
      throw new Error("Label name is required");
    if (
      this.labels.some(
        (label) =>
          label.id !== id &&
          label.name.toLocaleLowerCase() ===
            normalized.toLocaleLowerCase(),
      )
    ) {
      throw new Error(
        "A label with this name already exists",
      );
    }
    const index = this.labels.findIndex(
      (label) => label.id === id,
    );
    if (index === -1) return;
    this.dependencies.setLabels(index, "name", normalized);
    void this.repository
      .putLabel?.(this.labels[index])
      .catch((error) =>
        console.error(
          "[MessageStore] could not persist label",
          error,
        ),
      );
  }

  deleteLabel(id: string): void {
    for (const conversation of this.conversations) {
      if (conversation.labelIds.includes(id)) {
        this.setConversationLabels(
          conversation.id,
          conversation.labelIds.filter(
            (labelId) => labelId !== id,
          ),
        );
      }
    }
    this.dependencies.setLabels(
      reconcile(
        this.labels.filter((label) => label.id !== id),
      ),
    );
    void this.repository
      .removeLabel?.(id)
      .catch((error) =>
        console.error(
          "[MessageStore] could not remove label",
          error,
        ),
      );
  }

  setConversationLabels(
    id: string,
    labelIds: string[],
  ): void {
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id,
    );
    if (index === -1) return;
    const ids = [...new Set(labelIds)].filter((labelId) =>
      this.labels.some((label) => label.id === labelId),
    );
    this.dependencies.setConversations(
      index,
      "labelIds",
      reconcile(ids),
    );
    this.persist(this.conversations[index]);
  }

  clearConversation(id: string): void {
    const messages = this.getConversationMessages(id);
    this.dependencies.removeMessages(
      messages.map((message) => message.id),
    );
    this.dependencies.setMessages(
      reconcile(
        this.messages.filter(
          (message) => message.conversationId !== id,
        ),
      ),
    );
  }

  deleteConversation(id: string): void {
    this.clearConversation(id);
    // Queue deletion before publishing the removal: an active room observer
    // may immediately recreate its metadata in response to this state change.
    void this.repository
      .removeConversation?.(id)
      .catch((error) =>
        console.error(
          "[MessageStore] could not remove conversation",
          error,
        ),
      );
    this.dependencies.setConversations(
      reconcile(
        this.conversations.filter(
          (conversation) => conversation.id !== id,
        ),
      ),
    );
  }
}
