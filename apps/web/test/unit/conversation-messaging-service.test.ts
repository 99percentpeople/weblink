import { describe, expect, it, vi } from "vitest";
import {
  ConversationMessagingService,
  type ConversationMessagingOptions,
} from "@/libs/application/messaging/conversation-messaging-service";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { CHAT_MAX_TEXT_LENGTH } from "@/libs/domain/protocol/chat-text";
import type { StoreMessage } from "@/libs/domain/message";
import {
  deferred,
  makeSession,
} from "../support/rtc-transport";

describe("conversation submission boundary", () => {
  function setup() {
    const direct: Conversation = {
      id: directConversationId("local", "peer"),
      kind: "direct",
      peerId: "peer",
      title: "Peer",
      labelIds: [],
      createdAt: 1,
    };
    const room: Conversation = {
      id: roomConversationId("server", "room"),
      kind: "room",
      namespace: "server",
      roomId: "room",
      title: "Room",
      labelIds: [],
      createdAt: 1,
    };
    let activeRoom: string | null = room.id;
    const session = Object.assign(
      makeSession("local", "peer"),
      { isMessageChannelReady: true },
    );
    const completion = deferred<void>();
    const messages = new Map<string, StoreMessage>([
      [
        "accepted",
        {
          id: "accepted",
          type: "text",
          conversationId: direct.id,
          client: "local",
          target: "peer",
          createdAt: 1,
          data: "hello",
          status: "received",
          deliveries: { peer: "delivered" },
        },
      ],
    ]);
    const options = {
      getConversation: (id: string) =>
        [direct, room].find((item) => item.id === id),
      getMessage: (id: string) => messages.get(id),
      getLocalClientId: () => "local",
      getActiveRoomId: () => activeRoom,
      getSession: () => session,
      peers: {
        send: vi.fn<
          ConversationMessagingOptions["peers"]["send"]
        >(async (_session, _type, _data, options) => {
          await options?.onStored?.(
            createSessionMessage(_session, _type, _data, {
              id: "accepted",
            }),
          );
          await completion.promise;
          return null;
        }),
      },
      rooms: {
        retry: vi.fn(async () => {}),
        currentScopeKey: "scope",
        send: vi.fn<
          ConversationMessagingOptions["rooms"]["send"]
        >(async (_text, onStored) => {
          onStored?.("accepted");
          await completion.promise;
        }),
      },
      files: {
        retryFile: vi.fn(async () => {}),
        sendFile: vi.fn<
          ConversationMessagingOptions["files"]["sendFile"]
        >(async (_session, _file, options) => {
          options?.onStored?.("accepted");
          await completion.promise;
        }),
      },
      roomFiles: {
        sendFile: vi.fn<
          ConversationMessagingOptions["roomFiles"]["sendFile"]
        >(async (_file, onStored) => {
          onStored?.("accepted");
          await completion.promise;
        }),
      },
    };
    return {
      service: new ConversationMessagingService(options),
      direct,
      room,
      options,
      session,
      completion,
      messages,
      leave: () => {
        activeRoom = null;
      },
    };
  }

  it.each(["direct", "room"] as const)(
    "reports failed %s recipients even when the transport adapter resolves",
    async (kind) => {
      const f = setup();
      const accepted = await f.service.sendText(
        f[kind].id,
        "hello",
      );
      Object.assign(f.messages.get(accepted.messageId)!, {
        status: "error",
        deliveries: { peer: "failed" },
      });
      f.completion.resolve();
      expect(
        (await accepted.completion).error,
      ).toBeInstanceOf(Error);
    },
  );

  it.each(["direct", "room"] as const)(
    "accepts %s text before network completion, with the same validation",
    async (kind) => {
      const f = setup();
      await expect(
        f.service.sendText(f[kind].id, " "),
      ).rejects.toThrow();
      await expect(
        f.service.sendText(
          f[kind].id,
          "a".repeat(CHAT_MAX_TEXT_LENGTH + 1),
        ),
      ).rejects.toThrow();
      const accepted = await f.service.sendText(
        f[kind].id,
        " hello ",
      );
      expect(accepted.messageId).toBe("accepted");
      let completed = false;
      void accepted.completion.then(() => {
        completed = true;
      });
      expect(completed).toBe(false);
      f.completion.reject(
        new Error("offline after acceptance"),
      );
      expect(
        (await accepted.completion).error,
      ).toBeInstanceOf(Error);
    },
  );

  it.each(["direct", "room"] as const)(
    "uses the same acceptance contract for %s attachments",
    async (kind) => {
      const f = setup();
      const accepted = await f.service.sendFile(
        f[kind].id,
        { kind: "library", localFileId: "file" },
      );
      expect(accepted.messageId).toBe("accepted");
      f.completion.resolve();
      expect(await accepted.completion).toEqual({});
    },
  );

  it("rejects stale destinations instead of forwarding into a new conversation", async () => {
    const f = setup();
    const pending = f.service.sendText(f.room.id, "hello");
    f.leave();
    await expect(pending).rejects.toThrow();
    expect(f.options.rooms.send).not.toHaveBeenCalled();
    f.session.isMessageChannelReady = false;
    await expect(
      f.service.sendFile(f.direct.id, {
        kind: "library",
        localFileId: "file",
      }),
    ).rejects.toThrow("Member is not connected");
    expect(f.options.files.sendFile).not.toHaveBeenCalled();
  });

  it("retries the stored private identity and never revives deleted history", async () => {
    const f = setup();
    const message = f.messages.get("accepted")!;
    message.status = "error";
    const stale = {
      ...message,
      data: "stale UI content",
      createdAt: 99,
    };
    const retry = f.service.retryMessage(stale);
    expect(f.options.peers.send).toHaveBeenCalledWith(
      f.session,
      "send-text",
      { data: "hello" },
      {
        id: "accepted",
        createdAt: 1,
        retry: true,
        throwOnError: true,
      },
    );
    f.completion.resolve();
    await retry;
    f.messages.delete(message.id);
    await expect(
      f.service.retryMessage(stale),
    ).rejects.toThrow("Message was removed");
    expect(f.options.peers.send).toHaveBeenCalledOnce();
  });

  it("reports failed room retries using persisted recipient state", async () => {
    const f = setup();
    const message = f.messages.get("accepted")!;
    Object.assign(message, {
      conversationId: f.room.id,
      room: {
        roomId: "room",
        senderName: "Local",
        senderAvatar: null,
      },
      status: "error",
      deliveries: { peer: "failed" },
    });
    await expect(
      f.service.retryMessage(message),
    ).rejects.toThrow("Message delivery did not complete");
    expect(f.options.rooms.retry).toHaveBeenCalledWith(
      message,
    );
    message.status = "received";
    await f.service.retryMessage(message);
  });
});
