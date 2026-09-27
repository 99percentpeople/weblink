import { describe, expect, it } from "vitest";
import {
  createSessionMessage,
  P2P_ROOM_CHAT_PROTOCOL_VERSION,
  ROOM_CHAT_MAX_TEXT_LENGTH,
} from "@/libs/domain/protocol/messages";
import { validateSessionMessage } from "@/libs/domain/protocol/validation";

const peer = { clientId: "a", targetClientId: "b" };
const text = createSessionMessage(peer, "send-room-text", {
  roomId: "room",
  senderToken: "a-token",
  recipientToken: "b-token",
  senderName: "Alice",
  senderAvatar: null,
  data: "Hello",
});

describe("room chat wire contract", () => {
  it.each([
    { conversationId: "room:injected" },
    {
      room: {
        roomId: "injected",
        senderName: "Alice",
        senderAvatar: null,
      },
    },
    { deliveries: { other: "delivered" } },
    { localSequence: 100 },
    { lastReadSequence: 100 },
  ])(
    "rejects local storage fields on a legacy private envelope: %j",
    (localFields) => {
      expect(() =>
        validateSessionMessage({
          ...createSessionMessage(peer, "send-text", {
            data: "private",
          }),
          ...localFields,
        }),
      ).toThrow();
    },
  );

  it("uses independent versioned types while keeping transport target a peer", () => {
    expect(validateSessionMessage(text)).toMatchObject({
      version: P2P_ROOM_CHAT_PROTOCOL_VERSION,
      target: "b",
      roomId: "room",
    });
    expect(
      validateSessionMessage(
        createSessionMessage(peer, "room-capabilities", {
          roomId: "room",
          token: "a-token",
        }),
      ),
    ).toMatchObject({ version: 1 });
  });

  it.each([
    ["missing version", { version: undefined }],
    ["future version", { version: 2 }],
    ["empty room", { roomId: "" }],
    ["missing sender token", { senderToken: undefined }],
    [
      "missing recipient token",
      { recipientToken: undefined },
    ],
    ["invalid profile", { senderName: 1 }],
    ["oversized profile", { senderName: "a".repeat(129) }],
    ["empty text", { data: "   " }],
    [
      "oversized text",
      { data: "a".repeat(ROOM_CHAT_MAX_TEXT_LENGTH + 1) },
    ],
  ])("rejects %s", (_name, patch) => {
    expect(() =>
      validateSessionMessage({ ...text, ...patch }),
    ).toThrow();
  });
});
