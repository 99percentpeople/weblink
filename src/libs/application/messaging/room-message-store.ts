import {
  produce,
  reconcile,
  type SetStoreFunction,
} from "solid-js/store";
import type { Conversation } from "@/libs/domain/conversation";
import type {
  StoreMessage,
  RoomMessage,
  RoomDeliveryStatus,
} from "@/libs/domain/message";
import type { MessageRepository } from "./message-repository";
import { snapshotStoreMessage } from "./message-snapshot";

export interface RoomMessageStoreDependencies {
  messages: StoreMessage[];
  conversations: Conversation[];
  initialize(): Promise<void>;
  withLocalSequence<T extends StoreMessage>(message: T): T;
  setMessages: SetStoreFunction<StoreMessage[]>;
}

/** Durable room insertion and serialized per-recipient receipts, without networking. */
export class RoomMessageStore {
  private pendingRoomMessages = new Map<
    string,
    { message: RoomMessage; promise: Promise<void> }
  >();
  private deliveryWrites = new Map<string, Promise<void>>();
  private conversationVersions = new Map<string, number>();

  invalidateConversation(id: string): void {
    this.conversationVersions.set(
      id,
      (this.conversationVersions.get(id) ?? 0) + 1,
    );
  }
  constructor(
    private readonly repository: MessageRepository,
    private readonly dependencies: RoomMessageStoreDependencies,
  ) {}
  private get messages() {
    return this.dependencies.messages;
  }
  private get conversations() {
    return this.dependencies.conversations;
  }

  private assertSameRoomMessage(
    current: StoreMessage,
    incoming: RoomMessage,
  ): void {
    if (
      current.type !== incoming.type ||
      !current.room ||
      current.conversationId !== incoming.conversationId ||
      current.client !== incoming.client ||
      current.createdAt !== incoming.createdAt ||
      current.room.roomId !== incoming.room?.roomId
    ) {
      throw new Error("Conflicting room message identity");
    }
    if (
      current.type === "text" &&
      incoming.type === "text"
    ) {
      if (current.data === incoming.data) return;
    } else if (
      current.type === "file" &&
      incoming.type === "file"
    ) {
      if (
        current.fid === incoming.fid &&
        current.fileName === incoming.fileName &&
        current.fileSize === incoming.fileSize &&
        current.mimeType === incoming.mimeType &&
        current.lastModified === incoming.lastModified &&
        current.chunkSize === incoming.chunkSize &&
        JSON.stringify(current.fingerprint) ===
          JSON.stringify(incoming.fingerprint)
      )
        return;
    }
    throw new Error("Conflicting room message identity");
  }

  async putRoomMessage(
    message: RoomMessage,
  ): Promise<boolean> {
    const conversationId = message.conversationId;
    if (!conversationId)
      throw new Error(
        "Room message does not belong to a known room conversation",
      );
    const version =
      this.conversationVersions.get(conversationId);
    await this.dependencies.initialize();
    if (
      version !==
      this.conversationVersions.get(conversationId)
    )
      throw new Error(
        "Conversation history was cleared while saving the message",
      );
    const conversation = this.conversations.find(
      (item) => item.id === message.conversationId,
    );
    if (
      !message.room ||
      (message.type === "file" && !message.fid) ||
      conversation?.kind !== "room" ||
      conversation.roomId !== message.room.roomId
    ) {
      throw new Error(
        "Room message does not belong to a known room conversation",
      );
    }
    const existing = this.messages.find(
      (item) => item.id === message.id,
    );
    if (existing) {
      this.assertSameRoomMessage(existing, message);
      return false;
    }
    const pending = this.pendingRoomMessages.get(
      message.id,
    );
    if (pending) {
      this.assertSameRoomMessage(pending.message, message);
      await pending.promise;
      return false;
    }
    const snapshot = snapshotStoreMessage(
      this.dependencies.withLocalSequence({
        ...message,
        localSequence: undefined,
      }),
    );
    const promise = (async () => {
      await this.repository.putConversation?.({
        ...conversation,
        labelIds: [...conversation.labelIds],
      });
      await this.repository.putMessage(snapshot);
      if (
        !this.conversations.includes(conversation) ||
        version !==
          this.conversationVersions.get(conversationId)
      ) {
        await this.repository.removeMessage(snapshot.id);
        throw new Error(
          "Conversation was cleared or deleted while saving the message",
        );
      }
      this.dependencies.setMessages(
        produce((state) => {
          const index = state.findIndex(
            (item) =>
              (item.localSequence ?? 0) >
              snapshot.localSequence!,
          );
          state.splice(
            index === -1 ? state.length : index,
            0,
            snapshot,
          );
        }),
      );
    })();
    this.pendingRoomMessages.set(message.id, {
      message: snapshot,
      promise,
    });
    try {
      await promise;
      return true;
    } finally {
      this.pendingRoomMessages.delete(message.id);
    }
  }

  private async enqueueWrite(
    messageId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous =
      this.deliveryWrites.get(messageId) ??
      Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(operation);
    this.deliveryWrites.set(messageId, write);
    try {
      await write;
    } finally {
      if (this.deliveryWrites.get(messageId) === write)
        this.deliveryWrites.delete(messageId);
    }
  }

  /** Share receipt ordering with synchronous progress updates from transfer runs. */
  persistCurrentRoomMessage(
    messageId: string,
  ): Promise<void> {
    return this.enqueueWrite(messageId, async () => {
      const current = this.messages.find(
        (message) => message.id === messageId,
      );
      if (!current?.room) return;
      await this.repository.putMessage(
        snapshotStoreMessage(current),
      );
      if (
        !this.messages.some(
          (message) => message.id === messageId,
        )
      )
        await this.repository.removeMessage(messageId);
    });
  }

  setRoomDelivery(
    messageId: string,
    peerId: string,
    status: RoomDeliveryStatus,
  ): Promise<void> {
    return this.enqueueWrite(messageId, async () => {
      const index = this.messages.findIndex(
        (message) => message.id === messageId,
      );
      const message = this.messages[index];
      if (!message || !message.room)
        throw new Error("Unknown room message");
      const snapshot: RoomMessage = {
        ...snapshotStoreMessage(message),
        deliveries: {
          ...message.deliveries,
          [peerId]: status,
        },
      };
      await this.repository.putMessage(snapshot);
      const currentIndex = this.messages.findIndex(
        (item) => item.id === messageId,
      );
      if (currentIndex !== -1)
        this.dependencies.setMessages(
          currentIndex,
          "deliveries",
          reconcile(snapshot.deliveries),
        );
      else await this.repository.removeMessage(messageId);
    });
  }
}
