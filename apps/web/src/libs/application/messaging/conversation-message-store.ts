import {
  produce,
  type SetStoreFunction,
} from "solid-js/store";
import type { Conversation } from "@/libs/domain/conversation";
import type {
  StoreMessage,
  MessageDeliveryStatus,
} from "@/libs/domain/message";
import type { MessageRepository } from "./message-repository";
import { deliveryStatus } from "./message-delivery";
import { snapshotStoreMessage } from "./message-snapshot";

export interface ConversationMessageStoreDependencies {
  messages: StoreMessage[];
  conversations: Conversation[];
  initialize(): Promise<void>;
  attach(message: StoreMessage): StoreMessage;
  withLocalSequence<T extends StoreMessage>(message: T): T;
  setMessages: SetStoreFunction<StoreMessage[]>;
}

/** Shared durable insertion, identity checks and ordered message updates. */
export class ConversationMessageStore {
  private pendingMessages = new Map<
    string,
    { message: StoreMessage; promise: Promise<void> }
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
    private readonly dependencies: ConversationMessageStoreDependencies,
  ) {}
  private get messages() {
    return this.dependencies.messages;
  }
  private get conversations() {
    return this.dependencies.conversations;
  }

  assertSameMessage(
    current: StoreMessage,
    incoming: StoreMessage,
    fileRequest = false,
  ): void {
    const conflict = () => {
      throw new Error(
        current.room || incoming.room
          ? "Conflicting room message identity"
          : "Conflicting message identity",
      );
    };
    if (
      current.type !== incoming.type ||
      Boolean(current.room) !== Boolean(incoming.room) ||
      current.conversationId !== incoming.conversationId ||
      current.client !== incoming.client ||
      (!current.room &&
        current.target !== incoming.target) ||
      (!fileRequest &&
        current.createdAt !== incoming.createdAt) ||
      current.room?.roomId !== incoming.room?.roomId
    )
      conflict();
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
        (current.mimeType ?? "") ===
          (incoming.mimeType ?? "") &&
        current.lastModified === incoming.lastModified &&
        current.chunkSize === incoming.chunkSize &&
        (fileRequest ||
          JSON.stringify(current.fingerprint) ===
            JSON.stringify(incoming.fingerprint))
      )
        return;
    }
    conflict();
  }

  async putMessage(
    message: StoreMessage,
    fileRequest = false,
  ): Promise<boolean> {
    const conversationId = message.conversationId;
    if (!conversationId)
      throw new Error(
        "Message does not belong to a known conversation",
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
    message = this.dependencies.attach({
      ...message,
      localSequence: 0,
    });
    const conversation = this.conversations.find(
      (item) => item.id === message.conversationId,
    );
    if (
      !conversation ||
      (message.room
        ? conversation.kind !== "room" ||
          conversation.roomId !== message.room.roomId ||
          (message.type === "file" && !message.fid)
        : conversation.kind !== "direct")
    )
      throw new Error(
        "Message does not belong to a known conversation",
      );
    const existing = this.messages.find(
      (item) => item.id === message.id,
    );
    if (existing) {
      this.assertSameMessage(
        existing,
        message,
        fileRequest,
      );
      return false;
    }
    const pending = this.pendingMessages.get(message.id);
    if (pending) {
      this.assertSameMessage(
        pending.message,
        message,
        fileRequest,
      );
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
      await this.repository.putConversation?.(conversation);
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
    this.pendingMessages.set(message.id, {
      message: snapshot,
      promise,
    });
    try {
      await promise;
      return true;
    } finally {
      this.pendingMessages.delete(message.id);
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
  persistCurrentMessage(messageId: string): Promise<void> {
    return this.enqueueWrite(messageId, async () => {
      const current = this.messages.find(
        (message) => message.id === messageId,
      );
      if (!current) throw new Error("Message was removed");
      await this.repository.putMessage(current);
      if (
        !this.messages.some(
          (message) => message.id === messageId,
        )
      ) {
        await this.repository.removeMessage(messageId);
        throw new Error("Message was removed");
      }
    });
  }

  /** Patch only owned fields so concurrent transfer progress is retained. */
  update(
    messageId: string,
    project: (
      current: StoreMessage,
    ) => Partial<StoreMessage> | null,
  ): Promise<void> {
    return this.enqueueWrite(messageId, async () => {
      const current = this.messages.find(
        (message) => message.id === messageId,
      );
      if (!current) throw new Error("Message was removed");
      const patch = project(current);
      if (!patch) return;
      const snapshot = snapshotStoreMessage({
        ...current,
        ...patch,
      } as StoreMessage);
      try {
        await this.repository.putMessage(snapshot);
      } catch (error) {
        const index = this.messages.findIndex(
          (message) => message.id === messageId,
        );
        if (index !== -1)
          this.dependencies.setMessages(index, {
            status: "error",
            error:
              error instanceof Error
                ? error.message
                : String(error),
            ...(current.deliveries
              ? {
                  deliveries: Object.fromEntries(
                    Object.entries(current.deliveries).map(
                      ([peer, status]) => [
                        peer,
                        status === "sending"
                          ? "failed"
                          : status,
                      ],
                    ),
                  ),
                }
              : {}),
          });
        throw error;
      }
      const index = this.messages.findIndex(
        (message) => message.id === messageId,
      );
      if (index === -1) {
        await this.repository.removeMessage(messageId);
        throw new Error("Message was removed");
      }
      this.dependencies.setMessages(
        index,
        produce((message) => Object.assign(message, patch)),
      );
    });
  }

  setDelivery(
    messageId: string,
    peerId: string,
    status: MessageDeliveryStatus,
  ): Promise<void> {
    return this.update(messageId, (message) => {
      const deliveries = {
        ...message.deliveries,
        [peerId]: status,
      };
      return {
        deliveries,
        status: deliveryStatus(deliveries),
        error: undefined,
      };
    });
  }
}
