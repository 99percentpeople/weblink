import { describe, expect, it } from "vitest";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { validateSessionMessage } from "@/libs/domain/protocol/validation";
import { validCurrentCapability } from "@/libs/domain/protocol/capabilities";

const peer = { clientId: "a", targetClientId: "b" };
const metadata = {
  fid: "file",
  fileName: "file.bin",
  fileSize: 10,
  chunkSize: 1024,
};
const requests = [
  createSessionMessage(peer, "send-file", metadata),
  createSessionMessage(peer, "request-file", {
    ...metadata,
    resume: true,
  }),
  createSessionMessage(peer, "request-room-file", {
    fid: "file",
    offerId: "offer",
    resume: true,
    roomId: "room",
    senderToken: "sender",
    recipientToken: "recipient",
  }),
  createSessionMessage(peer, "request-shared-file", {
    fid: "file",
    transferId: "shared-transfer_queued",
    chunkSize: 1024,
    have: false,
    fingerprint: {
      version: 1,
      algorithm: "blake3-256",
      size: 10,
      digest: "0".repeat(64),
    },
  }),
];

describe("optional transfer queue negotiation", () => {
  it.each(requests)(
    "accepts legacy and queued $type requests but rejects malformed flags",
    (message) => {
      expect(validateSessionMessage(message)).toMatchObject(
        { type: message.type },
      );
      expect(
        validateSessionMessage({ ...message, queue: true }),
      ).toMatchObject({ queue: true });
      for (const queue of [1, "true", null, {}])
        expect(() =>
          validateSessionMessage({ ...message, queue }),
        ).toThrow();
    },
  );

  it("keeps existing files capabilities compatible and validates the optional queue flag", () => {
    const files = { content: true, shared: true };
    expect(validCurrentCapability("files", files)).toBe(
      true,
    );
    expect(
      validCurrentCapability("files", {
        ...files,
        queue: true,
      }),
    ).toBe(true);
    expect(
      validCurrentCapability("files", {
        ...files,
        queue: "true",
      }),
    ).toBe(false);
  });
});
