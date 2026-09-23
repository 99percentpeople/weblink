import { describe, expect, it } from "vitest";
import { getRoomMembers } from "@/libs/application/messaging/room-members";
import {
  directConversationId,
  roomConversationId,
  type Conversation,
} from "@/libs/domain/conversation";
import type { Client } from "@/libs/domain/client";
import type { TextMessage } from "@/libs/domain/message";

const room = {
  id: roomConversationId("server", "meeting"),
  kind: "room",
  roomId: "meeting",
  namespace: "server",
  title: "Meeting",
  labelIds: [],
  createdAt: 0,
} satisfies Conversation;
const otherRoom = roomConversationId(
  "other-server",
  "meeting",
);
const client = (clientId: string): Client => ({
  clientId,
  name: clientId,
  avatar: null,
});
const direct = (
  peerId: string,
  roomIds?: string[],
): Conversation => ({
  id: directConversationId("me", peerId),
  kind: "direct",
  peerId,
  roomConversationIds: roomIds,
  title: `Saved ${peerId}`,
  labelIds: [],
  createdAt: 0,
});
const message = (
  sender: string,
  conversationId = room.id,
): TextMessage => ({
  id: sender,
  type: "text",
  data: "Room text",
  client: sender,
  target: "me",
  createdAt: 1,
  conversationId,
  room: {
    roomId: "meeting",
    senderName: sender,
    senderAvatar: null,
  },
});
const defaults = () => ({
  room,
  activeRoomId: room.id,
  localClient: client("me"),
  onlineClients: [] as Client[],
  clients: [] as Client[],
  conversations: [] as Conversation[],
  messages: [] as TextMessage[],
});

describe("room members", () => {
  it("shows current members even without private history and deduplicates retained contacts", () => {
    const result = getRoomMembers({
      ...defaults(),
      onlineClients: [
        client("new"),
        client("saved"),
        client("saved"),
        client("me"),
      ],
      conversations: [
        direct("saved", [room.id]),
        direct("me", [room.id]),
      ],
    });
    expect(
      result.online.map((item) => item.clientId),
    ).toEqual(["me", "new", "saved"]);
    expect(result.online[0].self).toBe(true);
    expect(result.previous).toEqual([]);
  });

  it("requires a retained private conversation plus room-specific membership or legacy message evidence", () => {
    const result = getRoomMembers({
      ...defaults(),
      conversations: [
        direct("silent", [room.id]),
        direct("speaker"),
        direct("recipient"),
        direct("unrelated", [otherRoom]),
      ],
      clients: [
        {
          ...client("silent"),
          name: "Updated silent name",
          avatar: "avatar.png",
        },
      ],
      messages: [
        message("speaker"),
        {
          ...message("me"),
          deliveries: { recipient: "delivered" },
        },
        message("forgotten"),
        message("unrelated", otherRoom),
      ],
    });
    expect(
      result.previous.map((item) => item.clientId).sort(),
    ).toEqual(["recipient", "silent", "speaker"]);
    expect(
      result.previous.find(
        (item) => item.clientId === "silent",
      ),
    ).toMatchObject({
      name: "Updated silent name",
      avatar: "avatar.png",
    });
    expect(
      result.previous.find(
        (item) => item.clientId === "speaker",
      )?.name,
    ).toBe("Saved speaker");
  });

  it("does not show another room's current members as online, and removes forgotten private conversations", () => {
    const options = {
      ...defaults(),
      activeRoomId: otherRoom,
      onlineClients: [client("peer"), client("other")],
      conversations: [
        direct("peer", [room.id]),
        direct("other", [otherRoom]),
      ],
      messages: [message("peer")],
    };
    expect(getRoomMembers(options).online).toEqual([]);
    expect(
      getRoomMembers(options).previous.map(
        (item) => item.clientId,
      ),
    ).toEqual(["peer"]);
    options.conversations = [];
    expect(getRoomMembers(options).previous).toEqual([]);
    expect(
      getRoomMembers({ ...options, room: undefined }),
    ).toEqual({ online: [], previous: [] });
  });
});
