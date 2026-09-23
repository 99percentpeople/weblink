// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { FileSender } from "@/libs/domain/transfer/file-sender";
import type { ChunkCache } from "@/libs/domain/file";
import {
  FILE_TRANSFER_PACKET_HEADER_BYTES,
  readTransferPacket,
} from "@/libs/domain/transfer/packet";

vi.mock(
  "@/libs/domain/transfer/compress-worker?worker",
  () => ({
    default: class {
      onmessage?: (event: { data: unknown }) => void;
      postMessage(data: {
        data: Uint8Array;
        context: unknown;
      }) {
        queueMicrotask(() => this.onmessage?.({ data }));
      }
      terminate() {}
    },
  }),
);

class Channel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  onmessage = null;
  packets: ArrayBuffer[] = [];
  constructor(readonly limit: number) {
    super();
  }
  send(data: ArrayBuffer | string) {
    if (typeof data === "string") return;
    if (data.byteLength > this.limit)
      throw new TypeError("Message too large");
    this.packets.push(data);
  }
}

const contents = Uint8Array.from(
  { length: 192 * 1024 + 19 },
  (_, i) => i % 251,
);
function sender(
  blockSize: number,
  maxMessageSize?: number,
) {
  return new FileSender({
    cache: {
      id: "file",
      getInfo: async () => ({
        id: "file",
        fileName: "image.png",
        fileSize: contents.length,
        chunkSize: contents.length,
        isComplete: true,
      }),
      getChunk: async () => contents.slice().buffer,
    } as unknown as ChunkCache,
    blockSize,
    maxMessageSize,
  });
}

describe("file sender packet limits", () => {
  it.each([
    { block: 32768, limit: 32768, packet: 32768 },
    { block: 32768, limit: 8192, packet: 8192 },
    {
      block: 16384,
      limit: 65536,
      packet: 16384 + FILE_TRANSFER_PACKET_HEADER_BYTES,
    },
    { block: 192 * 1024, limit: undefined, packet: 65536 },
    {
      block: 192 * 1024,
      limit: 0,
      packet:
        192 * 1024 + FILE_TRANSFER_PACKET_HEADER_BYTES,
    },
  ])(
    "sends every byte within the packet budget for $block payload bytes and limit $limit",
    async ({ block, limit, packet }) => {
      const transfer = sender(block, limit);
      const channel = new Channel(packet);
      try {
        await transfer.initialize();
        transfer.setChannel(
          channel as unknown as RTCDataChannel,
        );
        await transfer.sendFile();
        expect(channel.packets.length).toBeGreaterThan(1);
        expect(
          Math.max(
            ...channel.packets.map(
              (item) => item.byteLength,
            ),
          ),
        ).toBe(packet);
        const decoded = channel.packets.map(
          readTransferPacket,
        );
        expect(
          decoded.map((item) => item.blockIndex),
        ).toEqual(decoded.map((_, i) => i));
        expect(
          decoded.filter((item) => item.isLastBlock),
        ).toEqual([decoded.at(-1)]);
        const actual = new Uint8Array(contents.length);
        let offset = 0;
        for (const item of decoded) {
          expect(item.chunkIndex).toBe(0);
          actual.set(item.blockData, offset);
          offset += item.blockData.length;
        }
        expect(offset).toBe(contents.length);
        expect(actual).toEqual(contents);
      } finally {
        transfer.close();
      }
    },
  );

  it("reports the original send failure before closing its run", async () => {
    const transfer = sender(32768, 32768);
    const channel = new Channel(1);
    const events: string[] = [];
    transfer.addEventListener("error", ({ detail }) =>
      events.push(detail.message),
    );
    transfer.addEventListener("close", () =>
      events.push("closed"),
    );
    await transfer.initialize();
    transfer.setChannel(
      channel as unknown as RTCDataChannel,
    );
    await expect(transfer.sendFile()).rejects.toThrow(
      "Message too large",
    );
    expect(events).toEqual(["Message too large", "closed"]);
  });

  it("rejects a channel limit that cannot even contain the binary header", () => {
    expect(() =>
      sender(32768, FILE_TRANSFER_PACKET_HEADER_BYTES),
    ).toThrow(/data channel limit/);
  });
});
