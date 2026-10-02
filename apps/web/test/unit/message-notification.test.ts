import { describe, expect, it } from "vitest";
import { messageNotificationContent } from "@/libs/application/notifications/message-notification";
import type { Conversation } from "@/libs/domain/conversation";
import type { TextMessage } from "@/libs/domain/message";

const message: TextMessage = {
  id: "message",
  type: "text",
  client: "peer",
  target: "local",
  createdAt: 1,
  data: "Hello",
};
const direct: Conversation = {
  id: "direct",
  kind: "direct",
  peerId: "peer",
  title: "Stored name",
  labelIds: [],
  createdAt: 1,
};
const room: Conversation = {
  id: "room",
  kind: "room",
  roomId: "room",
  namespace: "test",
  title: "Team",
  labelIds: [],
  createdAt: 1,
};
const sender = {
  name: "Alice",
  avatar: "data:image/png;base64,avatar",
};

describe("chat notification presentation", () => {
  it("pairs a private message with its sender's name and avatar", () => {
    expect(
      messageNotificationContent(
        message,
        direct,
        sender,
        true,
        "New message",
      ),
    ).toEqual({
      title: "Alice",
      body: "Hello",
      avatar: sender,
    });
  });
  it("identifies the room and uses the message snapshot when a sender has left", () => {
    const incoming = {
      ...message,
      room: {
        roomId: "room",
        senderName: "Bob",
        senderAvatar: "snapshot",
      },
    };
    expect(
      messageNotificationContent(
        incoming,
        room,
        undefined,
        true,
        "New message",
      ),
    ).toEqual({
      title: "Bob · Team",
      body: "Hello",
      avatar: { name: "Bob", avatar: "snapshot" },
    });
    expect(
      messageNotificationContent(
        incoming,
        room,
        sender,
        true,
        "New message",
      ).avatar,
    ).toEqual(sender);
  });
  it("hides sender, room, avatar and message when preview is disabled", () => {
    expect(
      messageNotificationContent(
        message,
        room,
        sender,
        false,
        "New message",
      ),
    ).toEqual({
      title: "New message",
      body: "New message",
    });
  });
  it("keeps file names and bounds peer-supplied text", () => {
    expect(
      messageNotificationContent(
        {
          ...message,
          type: "file",
          fileName: "notes.pdf",
          fileSize: 1,
          chunkSize: 1,
        },
        direct,
        sender,
        true,
        "New message",
      ).body,
    ).toBe("notes.pdf");
    const result = messageNotificationContent(
      { ...message, data: "a".repeat(9000) },
      room,
      { ...sender, name: "a".repeat(2000) },
      true,
      "New message",
    );
    expect(result.title.length).toBeLessThanOrEqual(163);
    expect(result.body.length).toBe(1000);
  });
});
