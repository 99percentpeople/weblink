import { describe, expect, it } from "vitest";
import {
  FILE_TRANSFER_CHANNEL_PROTOCOL,
  encodeTransferMessage,
  parseTransferMessage,
  validateTransferMessage,
} from "@/libs/domain/transfer/protocol";
import {
  FILE_TRANSFER_PACKET_HEADER_BYTES,
  buildTransferPacket,
  readTransferPacket,
} from "@/libs/domain/transfer/packet";

describe("portable file-transfer control protocol", () => {
  it("uses the stable transfer channel protocol name", () => {
    expect(FILE_TRANSFER_CHANNEL_PROTOCOL).toBe("transfer");
  });

  it("round-trips request-content ranges", () => {
    const encoded = encodeTransferMessage({
      type: "request-content",
      ranges: [0, [2, 4], 7],
    });

    expect(parseTransferMessage(encoded)).toEqual({
      type: "request-content",
      ranges: [0, [2, 4], 7],
    });
  });

  it("accepts the legacy head shape without browser-only File fields", () => {
    expect(
      validateTransferMessage({
        type: "head",
        id: "file-1",
        fileName: "report.bin",
        fileSize: 12,
        chunkSize: 4,
        mimetype: "application/octet-stream",
        createdAt: 1,
      }),
    ).toEqual({
      type: "head",
      id: "file-1",
      fileName: "report.bin",
      fileSize: 12,
      chunkSize: 4,
      mimetype: "application/octet-stream",
      createdAt: 1,
      lastModified: undefined,
      from: undefined,
    });
  });

  it.each([
    ["malformed JSON", "{"],
    [
      "negative chunk index",
      JSON.stringify({
        type: "request-content",
        ranges: [-1],
      }),
    ],
    [
      "reversed range",
      JSON.stringify({
        type: "request-content",
        ranges: [[4, 2]],
      }),
    ],
    [
      "invalid head size",
      JSON.stringify({
        type: "head",
        id: "f",
        fileName: "a.bin",
        fileSize: -1,
      }),
    ],
    ["unknown type", JSON.stringify({ type: "wat" })],
  ])("rejects %s", (_name, raw) => {
    expect(() => parseTransferMessage(raw)).toThrow(
      "Invalid file transfer message",
    );
  });
});

describe("portable file-transfer binary packet", () => {
  it("uses a seven-byte big-endian header", () => {
    const packet = buildTransferPacket(
      0x01020304,
      0x0506,
      true,
      new Uint8Array([0xaa, 0xbb]),
    );

    expect(FILE_TRANSFER_PACKET_HEADER_BYTES).toBe(7);
    expect(Array.from(new Uint8Array(packet))).toEqual([
      0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x01, 0xaa, 0xbb,
    ]);

    const decoded = readTransferPacket(packet);
    expect(decoded.chunkIndex).toBe(0x01020304);
    expect(decoded.blockIndex).toBe(0x0506);
    expect(decoded.isLastBlock).toBe(true);
    expect(Array.from(decoded.blockData)).toEqual([
      0xaa, 0xbb,
    ]);
  });

  it("validates packet bounds and last-block flag", () => {
    expect(() =>
      buildTransferPacket(-1, 0, false, new Uint8Array()),
    ).toThrow(RangeError);
    expect(() =>
      buildTransferPacket(
        0,
        0x1_0000,
        false,
        new Uint8Array(),
      ),
    ).toThrow(RangeError);
    expect(() =>
      readTransferPacket(new ArrayBuffer(6)),
    ).toThrow("Invalid file transfer packet");

    const invalidFlag = new ArrayBuffer(7);
    new DataView(invalidFlag).setUint8(6, 2);
    expect(() => readTransferPacket(invalidFlag)).toThrow(
      "Invalid file transfer packet",
    );
  });
});
