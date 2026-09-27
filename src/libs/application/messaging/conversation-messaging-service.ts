import {
  directConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import type { FileSource } from "@/libs/domain/file";
import type { StoreMessage } from "@/libs/domain/message";
import type { PeerSession } from "@/libs/domain/session";
import { normalizeChatText } from "@/libs/domain/protocol/chat-text";
import type { PeerMessagingService } from "./peer-messaging-service";
import type { RoomMessagingService } from "./room-messaging-service";
import type { RoomFileSharingService } from "./room-file-sharing-service";
import type { FileTransferService } from "../transfer/file-transfer-service";
import {
  submitMessage,
  type OnMessageAccepted,
  type MessageSubmission,
} from "./message-submission";

export interface ConversationMessagingOptions {
  getConversation(id: string): Conversation | undefined;
  getMessage(id: string): StoreMessage | undefined;
  getLocalClientId(): string;
  getSession(peerId: string): PeerSession | undefined;
  getActiveRoomId(): string | null;
  peers: Pick<PeerMessagingService, "send">;
  rooms: Pick<
    RoomMessagingService,
    "send" | "retry" | "currentScopeKey"
  >;
  files: Pick<
    FileTransferService,
    "sendFile" | "retryFile"
  >;
  roomFiles: Pick<RoomFileSharingService, "sendFile">;
}

/** UI commands are scoped to a conversation and finish at durable local acceptance. */
export class ConversationMessagingService {
  constructor(
    private readonly options: ConversationMessagingOptions,
  ) {}

  private assertDelivered(messageId: string): void {
    const message = this.options.getMessage(messageId);
    if (!message) throw new Error("Message was removed");
    if (message.status !== "received")
      throw new Error(
        message.error ??
          "Message delivery did not complete",
      );
  }

  private submit(
    operation: (
      accepted: OnMessageAccepted,
    ) => Promise<unknown>,
  ): Promise<MessageSubmission> {
    return submitMessage(async (accepted) => {
      let messageId: string | undefined;
      await operation((id) => {
        messageId = id;
        accepted(id);
      });
      // Fan-out may settle normally with failed recipients. Both adapters expose
      // completion from persisted delivery state, not merely promise resolution.
      if (messageId) this.assertDelivered(messageId);
    });
  }

  private destination(id: string): PeerSession | null {
    const conversation = this.options.getConversation(id);
    if (!conversation)
      throw new Error("Unknown conversation");
    if (conversation.kind === "room") {
      if (id !== this.options.getActiveRoomId())
        throw new Error(
          "Join the original room to send a message",
        );
      return null;
    }
    if (
      id !==
      directConversationId(
        this.options.getLocalClientId(),
        conversation.peerId,
      )
    )
      throw new Error(
        "Conversation belongs to a previous identity",
      );
    const session = this.options.getSession(
      conversation.peerId,
    );
    if (!session?.isMessageChannelReady)
      throw new Error("Member is not connected");
    return session;
  }

  async sendText(
    conversationId: string,
    text: string,
  ): Promise<MessageSubmission> {
    const data = normalizeChatText(text);
    const session = this.destination(conversationId);
    const scope = session
      ? null
      : this.options.rooms.currentScopeKey;
    return this.submit((accepted) => {
      // Revalidate before starting; preparation must never retarget a later room.
      if (
        this.destination(conversationId) !== session ||
        (!session &&
          scope !== this.options.rooms.currentScopeKey)
      )
        throw new Error("Conversation session changed");
      return session
        ? this.options.peers.send(
            session,
            "send-text",
            { data },
            {
              throwOnError: true,
              onStored: (message) => accepted(message.id),
            },
          )
        : this.options.rooms.send(data, accepted);
    });
  }

  async sendFile(
    conversationId: string,
    file: FileSource,
  ): Promise<MessageSubmission> {
    const session = this.destination(conversationId);
    const scope = session
      ? null
      : this.options.rooms.currentScopeKey;
    return this.submit((accepted) => {
      if (
        this.destination(conversationId) !== session ||
        (!session &&
          scope !== this.options.rooms.currentScopeKey)
      )
        throw new Error("Conversation session changed");
      return session
        ? this.options.files.sendFile(session, file, {
            onStored: accepted,
          })
        : this.options.roomFiles.sendFile(file, accepted);
    });
  }

  async retryMessage(
    snapshot: StoreMessage,
  ): Promise<void> {
    // Resolve stored identity again; a stale UI reference cannot revive deleted history.
    const message = this.options.getMessage(snapshot.id);
    if (!message?.conversationId)
      throw new Error("Message was removed");
    const session = this.destination(
      message.conversationId,
    );
    if (message.room) {
      await this.options.rooms.retry(message);
      this.assertDelivered(message.id);
      return;
    }
    if (!session)
      throw new Error(
        "Message does not belong to a private conversation",
      );
    if (message.type === "file") {
      await this.options.files.retryFile(session, message);
      return;
    }
    if (message.client !== this.options.getLocalClientId())
      throw new Error("Only your messages can be retried");
    if (message.status !== "error") return;
    await this.options.peers.send(
      session,
      "send-text",
      { data: message.data },
      {
        id: message.id,
        createdAt: message.createdAt,
        retry: true,
        throwOnError: true,
      },
    );
  }
}
