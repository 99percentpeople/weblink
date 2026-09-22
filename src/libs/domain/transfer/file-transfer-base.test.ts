import { describe, expect, it } from "vitest";
import type { ChunkCache } from "@/libs/domain/file";
import { FileTransferBase } from "./file-transfer-base";
import { TransferMode } from "./file-transferer";

class TestTransfer extends FileTransferBase {
  readonly mode = TransferMode.Send;

  protected handleReceiveMessage(): void {}

  public getAvailableChannel() {
    return super.getAvailableChannel();
  }
}

class FakeDataChannel extends EventTarget {
  readonly label = "test";
  readyState: RTCDataChannelState = "open";
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "blob";
  sent: unknown[] = [];
  onmessage:
    | ((this: RTCDataChannel, ev: MessageEvent) => any)
    | null = null;

  constructor(public bufferedAmount: number) {
    super();
  }

  send(data: unknown) {
    this.sent.push(data);
  }

  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

function createTransfer(
  lowWaterMark = 32 * 1024,
  highWaterMark?: number,
) {
  return new TestTransfer({
    cache: {} as ChunkCache,
    bufferedAmountLowThreshold: lowWaterMark,
    bufferedAmountHighWaterMark: highWaterMark,
  });
}

function asRTCDataChannel(channel: FakeDataChannel) {
  return channel as unknown as RTCDataChannel;
}

describe("FileTransferBase single-channel backpressure", () => {
  it("uses one transfer channel", async () => {
    const transfer = createTransfer();
    const channel = new FakeDataChannel(128 * 1024);

    transfer.setChannel(asRTCDataChannel(channel));

    expect(transfer.channel).toBe(channel);
    await expect(
      transfer.getAvailableChannel(),
    ).resolves.toBe(channel);
  });

  it("rejects replacing a live transfer channel", () => {
    const transfer = createTransfer();
    const first = new FakeDataChannel(0);
    const second = new FakeDataChannel(0);

    transfer.setChannel(asRTCDataChannel(first));

    expect(() =>
      transfer.setChannel(asRTCDataChannel(second)),
    ).toThrow("transfer channel is already set");
  });

  it("normalizes an old low-water mark above the configured high-water mark", async () => {
    const transfer = createTransfer(
      1024 * 1024,
      256 * 1024,
    );
    const channel = new FakeDataChannel(3 * 1024 * 1024);
    transfer.setChannel(asRTCDataChannel(channel));

    await expect(
      transfer.getAvailableChannel(),
    ).resolves.toBe(channel);
  });

  it("waits for bufferedamountlow after the high-water mark", async () => {
    const lowWaterMark = 64 * 1024;
    const transfer = createTransfer(lowWaterMark);
    const channel = new FakeDataChannel(5 * 1024 * 1024);
    transfer.setChannel(asRTCDataChannel(channel));

    let resolved = false;
    const available = transfer
      .getAvailableChannel()
      .then((value) => {
        resolved = true;
        return value;
      });

    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(channel.bufferedAmountLowThreshold).toBe(
      lowWaterMark,
    );

    channel.bufferedAmount = lowWaterMark;
    channel.dispatchEvent(new Event("bufferedamountlow"));

    await expect(available).resolves.toBe(channel);
  });

  it("treats a peer channel close during pause as an expected race", async () => {
    const transfer = createTransfer();
    const channel = new FakeDataChannel(1024);
    transfer.setChannel(asRTCDataChannel(channel));

    let error: Error | undefined;
    let closed = false;
    transfer.addEventListener("error", (event) => {
      error = event.detail;
    });
    transfer.addEventListener("close", () => {
      closed = true;
    });

    const pause = transfer.pause(true);
    await Promise.resolve();

    channel.close();

    await expect(pause).resolves.toBeUndefined();
    expect(error).toBeUndefined();
    expect(closed).toBe(true);
    expect(channel.sent).toEqual([
      JSON.stringify({ type: "pause" }),
    ]);
  });
});
