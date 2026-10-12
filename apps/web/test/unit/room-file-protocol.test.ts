import { describe, expect, it, vi } from "vitest";
import {
  createSessionMessage,
  P2P_ROOM_FILE_PROTOCOL_VERSION,
  requestSpec,
} from "@/libs/application/rtc/rtc-protocol";
import { P2PProtocol } from "@/libs/domain/protocol";
import { validateSessionMessage } from "@/libs/domain/protocol/validation";
import {
  FakeRtcTransport,
  makeSession,
} from "../support/rtc-transport";

const peer = makeSession("a", "b");
const binding = {
  roomId: "room",
  senderToken: "a-token",
  recipientToken: "b-token",
};
const metadata = {
  fid: "file",
  fileName: "report.pdf",
  fileSize: 8192,
  mimeType: "application/pdf",
  lastModified: 12,
  chunkSize: 4096,
};
const offer = () =>
  createSessionMessage(
    peer,
    "send-room-file",
    {
      ...binding,
      ...metadata,
      senderName: "Alice",
      senderAvatar: null,
    },
    { id: "offer" },
  );
const pull = () =>
  createSessionMessage(
    peer,
    "request-room-file",
    {
      ...binding,
      offerId: "offer",
      fid: "file",
      ranges: [0, [1, 2]],
      resume: false,
    },
    { id: "download" },
  );

describe("room file wire protocol", () => {
  it("exchanges room identity separately from service capabilities", () => {
    const message = createSessionMessage(
      peer,
      "room-capabilities",
      { roomId: "room", token: "token" },
    );
    expect(validateSessionMessage(message)).toMatchObject({
      roomId: "room",
      token: "token",
    });
    expect(message).not.toHaveProperty("features");
  });

  it("creates offers and pulls with independent ids and the defined ACK modes", () => {
    expect(validateSessionMessage(offer())).toMatchObject({
      type: "send-room-file",
      version: P2P_ROOM_FILE_PROTOCOL_VERSION,
      ...metadata,
    });
    expect(validateSessionMessage(pull())).toMatchObject({
      type: "request-room-file",
      version: 1,
      offerId: "offer",
      id: "download",
    });
    expect(requestSpec["send-room-file"].ack).toBe(
      "receive",
    );
    expect(requestSpec["request-room-file"].ack).toBe(
      "send",
    );
  });

  it.each([
    { version: 2 },
    { version: undefined },
    { roomId: "" },
    { senderToken: "" },
    { recipientToken: "" },
    { senderName: "x".repeat(129) },
    { fid: "" },
    { fileName: "" },
    { fileName: "x".repeat(1025) },
    { fileSize: -1 },
    { fileSize: Number.MAX_SAFE_INTEGER + 1 },
    { chunkSize: 0 },
    { mimeType: 3 },
    { mimeType: "x".repeat(256) },
    { lastModified: -1 },
    { roomTransfers: {} },
    {
      data: "binary payload must not be part of the offer",
    },
  ])("rejects invalid offer metadata %j", (patch) => {
    expect(() =>
      validateSessionMessage({ ...offer(), ...patch }),
    ).toThrow();
  });

  it.each([
    { id: "offer" },
    { offerId: "" },
    { fid: "" },
    { resume: 1 },
    { version: 2 },
    { ranges: [-1] },
    { ranges: [[2, 1]] },
    { ranges: [1.5] },
    { ranges: [[0, 1, 2]] },
    { fileName: "injected" },
    { fileSize: 0 },
    { chunkSize: 1 },
    { roomTransfers: {} },
  ])(
    "rejects invalid pulls and untrusted metadata %j",
    (patch) => {
      expect(() =>
        validateSessionMessage({ ...pull(), ...patch }),
      ).toThrow();
    },
  );

  it("replays a pull ACK once but executes a new download attempt separately", async () => {
    const transport = new FakeRtcTransport();
    const protocol = new P2PProtocol(transport);
    const handler = vi.fn();
    protocol.handle("request-room-file", handler);
    const receiving = makeSession("b", "a");
    const first = pull();
    try {
      await transport.emit(receiving, first);
      await transport.emit(receiving, first);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(
        transport.sendCalls.map((call) => call.message),
      ).toEqual([
        expect.objectContaining({
          type: "ack",
          id: "download",
          mode: "send",
        }),
        expect.objectContaining({
          type: "ack",
          id: "download",
          mode: "send",
        }),
      ]);
      await transport.emit(receiving, {
        ...first,
        id: "new-download",
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      protocol.dispose();
    }
  });
});
