// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { runSpeedTest } from "@/libs/domain/speed-test";
import {
  SPEED_TEST_PROTOCOL,
  SPEED_TEST_MAX_BYTES,
  SPEED_TEST_HIGH_WATER,
  encodeSpeedTestMessage,
  parseSpeedTestMessage,
  type SpeedTestProgress,
} from "@/libs/domain/speed-test-protocol";

class Channel extends EventTarget {
  protocol = SPEED_TEST_PROTOCOL;
  ordered = true;
  maxRetransmits = null;
  maxPacketLifeTime = null;
  binaryType = "arraybuffer";
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  peer?: Channel;
  payloadBytes = 0;
  maxPacketBytes = 0;
  maxBufferedBytes = 0;
  dropReceipts = false;
  corruptReceipt = false;
  stallPayload = false;
  closeCalls = 0;

  send(value: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== "open")
      throw new Error("not open");
    let data: string | ArrayBuffer =
      typeof value === "string"
        ? value
        : value instanceof ArrayBuffer
          ? value.slice(0)
          : (value.slice().buffer as ArrayBuffer);
    if (typeof data === "string") {
      const message = JSON.parse(data);
      if (message.type === "receipt") {
        if (this.dropReceipts) return;
        if (this.corruptReceipt)
          data = JSON.stringify({
            ...message,
            bytes: message.bytes - 1,
          });
      }
    } else {
      this.payloadBytes += data.byteLength;
      this.maxPacketBytes = Math.max(
        this.maxPacketBytes,
        data.byteLength,
      );
      if (this.stallPayload) {
        this.bufferedAmount += data.byteLength;
        this.maxBufferedBytes = Math.max(
          this.maxBufferedBytes,
          this.bufferedAmount,
        );
        return;
      }
    }
    const length =
      typeof data === "string"
        ? data.length
        : data.byteLength;
    this.bufferedAmount += length;
    this.maxBufferedBytes = Math.max(
      this.maxBufferedBytes,
      this.bufferedAmount,
    );
    setTimeout(() => {
      this.bufferedAmount -= length;
      this.dispatchEvent(new Event("bufferedamountlow"));
      if (this.peer?.readyState !== "closed") {
        this.peer?.dispatchEvent(
          new MessageEvent("message", { data }),
        );
      }
    }, 1);
  }

  close() {
    this.closeCalls++;
    if (
      this.readyState === "closed" ||
      this.readyState === "closing"
    )
      return;
    this.readyState = "closing";
    // Model graceful closure: previously sent receipts arrive first.
    setTimeout(() => {
      this.readyState = "closed";
      this.dispatchEvent(new Event("close"));
      if (this.peer && this.peer.readyState !== "closed") {
        this.peer.readyState = "closed";
        this.peer.dispatchEvent(new Event("close"));
      }
    }, 2);
  }
}

function pair() {
  const a = new Channel();
  const b = new Channel();
  a.peer = b;
  b.peer = a;
  return {
    a,
    b,
    rtcA: a as unknown as RTCDataChannel,
    rtcB: b as unknown as RTCDataChannel,
  };
}

beforeEach(() =>
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "Date",
      "performance",
    ],
  }),
);
afterEach(() => vi.useRealTimers());

describe("speed-test protocol validation", () => {
  it("round-trips the versioned portable control frames", () => {
    const messages = [
      {
        type: "hello",
        durationMs: 1000,
        maxBytes: 4096,
      },
      { type: "offer" },
      { type: "ready" },
      { type: "start", direction: "upload" },
      { type: "go", direction: "upload" },
      { type: "begin", direction: "upload" },
      { type: "end", direction: "upload", bytes: 4096 },
      {
        type: "receipt",
        direction: "upload",
        bytes: 4096,
        durationMs: 250,
      },
    ] as const;

    for (const message of messages) {
      expect(
        parseSpeedTestMessage(
          encodeSpeedTestMessage(message),
        ),
      ).toEqual(message);
    }
  });

  it.each([
    "null",
    "[]",
    "not-json",
    "x".repeat(1025),
    JSON.stringify({
      type: "hello",
      durationMs: 10001,
      maxBytes: 1000,
    }),
    JSON.stringify({
      type: "hello",
      durationMs: 1000,
      maxBytes: SPEED_TEST_MAX_BYTES + 1,
    }),
    JSON.stringify({
      type: "hello",
      durationMs: -1,
      maxBytes: 1,
    }),
    JSON.stringify({
      type: "hello",
      durationMs: 1,
      maxBytes: 1.1,
    }),
    JSON.stringify({
      type: "start",
      direction: "sideways",
    }),
    JSON.stringify({
      type: "receipt",
      direction: "upload",
      bytes: 1,
      durationMs: 0,
    }),
    JSON.stringify({
      type: "receipt",
      direction: "upload",
      bytes: 1,
      durationMs: 15001,
    }),
    JSON.stringify({ type: "other" }),
  ])("rejects malformed/unbounded control: %s", (raw) => {
    expect(() => parseSpeedTestMessage(raw)).toThrow();
  });
});

describe("real speed-test driver with paired channels", () => {
  it("measures both directions using receipts and a single channel, including a partial last packet", async () => {
    const { a, b, rtcA, rtcB } = pair();
    const bytes = 131_079;
    const states: SpeedTestProgress[] = [];
    const completed: Array<{
      direction: "upload" | "download";
      bytes: number;
    }> = [];
    const remoteCompleted: Array<{
      direction: "upload" | "download";
      bytes: number;
    }> = [];
    const remote = runSpeedTest(rtcB, "responder", {
      approve: async () => true,
      onMeasurement: (direction, measurement) =>
        remoteCompleted.push({
          direction,
          bytes: measurement.bytes,
        }),
    });
    const local = runSpeedTest(rtcA, "initiator", {
      maxBytes: bytes,
      onProgress: (p) => states.push(p),
      onMeasurement: (direction, measurement) =>
        completed.push({
          direction,
          bytes: measurement.bytes,
        }),
    });
    const results = Promise.all([local, remote]);
    await vi.runAllTimersAsync();
    const [left, right] = await results;
    expect(left.upload.bytes).toBe(bytes);
    expect(left.download.bytes).toBe(bytes);
    expect(left.upload).toEqual(right.download);
    expect(left.download).toEqual(right.upload);
    expect(left.upload.bytesPerSecond).toBe(
      (bytes * 1000) / left.upload.durationMs,
    );
    expect(a.payloadBytes).toBe(bytes);
    expect(b.payloadBytes).toBe(bytes);
    expect(a.maxPacketBytes).toBe(32 * 1024);
    expect(a.maxBufferedBytes).toBeLessThanOrEqual(
      SPEED_TEST_HIGH_WATER + 1024,
    );
    expect(states.map((p) => p.phase)).toEqual(
      expect.arrayContaining([
        "approval",
        "upload",
        "download",
      ]),
    );
    expect(completed).toEqual([
      { direction: "upload", bytes },
      { direction: "download", bytes },
    ]);
    expect(remoteCompleted).toEqual([
      { direction: "download", bytes },
      { direction: "upload", bytes },
    ]);
    expect(a.readyState).toBe("closed");
    expect(b.readyState).toBe("closed");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not send payload until the peer approves", async () => {
    const { a, b, rtcA, rtcB } = pair();
    let approve!: (value: boolean) => void;
    const remote = runSpeedTest(rtcB, "responder", {
      approve: () =>
        new Promise((resolve) => {
          approve = resolve;
        }),
    });
    const local = runSpeedTest(rtcA, "initiator", {
      maxBytes: 65537,
    });
    const results = Promise.all([local, remote]);
    await vi.advanceTimersByTimeAsync(20);
    expect(a.payloadBytes + b.payloadBytes).toBe(0);
    approve(true);
    await vi.runAllTimersAsync();
    await expect(results).resolves.toHaveLength(2);
  });

  it("declines by default, without sending any test payload", async () => {
    const { a, b, rtcA, rtcB } = pair();
    const results = Promise.allSettled([
      runSpeedTest(rtcB, "responder"),
      runSpeedTest(rtcA, "initiator"),
    ]);
    await vi.runAllTimersAsync();
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "declined" },
      });
    }
    expect(a.payloadBytes + b.payloadBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("detects old peers that never acknowledge the protocol", async () => {
    const { a, rtcA } = pair();
    const result = runSpeedTest(rtcA, "initiator").catch(
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      code: "unsupported",
    });
    expect(a.payloadBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels pending approval, even when its callback never resolves", async () => {
    const { a, b, rtcA, rtcB } = pair();
    const controller = new AbortController();
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator", {
        signal: controller.signal,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: () => new Promise(() => {}),
      }),
    ]);
    await vi.advanceTimersByTimeAsync(20);
    controller.abort();
    await vi.runAllTimersAsync();
    const outcomes = await results;
    expect(outcomes[0]).toMatchObject({
      status: "rejected",
      reason: { code: "cancelled" },
    });
    expect(outcomes[1]).toMatchObject({
      status: "rejected",
      reason: { code: "closed" },
    });
    expect(a.payloadBytes + b.payloadBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels while backpressured without producing unbounded data", async () => {
    const { a, rtcA, rtcB } = pair();
    a.stallPayload = true;
    const controller = new AbortController();
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator", {
        signal: controller.signal,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.advanceTimersByTimeAsync(20);
    expect(a.payloadBytes).toBeGreaterThan(0);
    expect(a.payloadBytes).toBeLessThanOrEqual(
      SPEED_TEST_HIGH_WATER,
    );
    controller.abort();
    await vi.runAllTimersAsync();
    expect((await results)[0]).toMatchObject({
      status: "rejected",
      reason: { code: "cancelled" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not treat queued bytes as a result without a receipt", async () => {
    const { b, rtcA, rtcB } = pair();
    b.dropReceipts = true;
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator", {
        maxBytes: 100_001,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.runAllTimersAsync();
    expect((await results)[0].status).toBe("rejected");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an incorrect receiver byte count", async () => {
    const { b, rtcA, rtcB } = pair();
    b.corruptReceipt = true;
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator", {
        maxBytes: 100_001,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.runAllTimersAsync();
    expect((await results)[0]).toMatchObject({
      status: "rejected",
      reason: { code: "protocol" },
    });
  });

  it("clamps packets to the negotiated message size", async () => {
    const { a, rtcA, rtcB } = pair();
    const results = Promise.all([
      runSpeedTest(rtcA, "initiator", {
        maxMessageSize: 8192,
        maxBytes: 65_537,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.runAllTimersAsync();
    await results;
    expect(a.maxPacketBytes).toBe(8192);
  });

  it("stops pumping after the time budget even before reaching the byte budget", async () => {
    const { rtcA, rtcB } = pair();
    const bytes = 2 * 1024 * 1024;
    const results = Promise.all([
      runSpeedTest(rtcA, "initiator", {
        durationMs: 2,
        maxBytes: bytes,
      }),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.runAllTimersAsync();
    const [result] = await results;
    expect(result.upload.bytes).toBeGreaterThan(0);
    expect(result.upload.bytes).toBeLessThan(bytes);
    expect(result.download.bytes).toBeLessThan(bytes);
  });

  it("rejects a receipt arriving before the sender has queued the end marker", async () => {
    const { a, b, rtcA, rtcB } = pair();
    a.stallPayload = true;
    b.addEventListener("message", (event) => {
      const data = (event as MessageEvent).data;
      if (
        typeof data === "string" &&
        JSON.parse(data).type === "begin"
      ) {
        b.send(
          JSON.stringify({
            type: "receipt",
            direction: "upload",
            bytes: 1,
            durationMs: 1,
          }),
        );
      }
    });
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator"),
      runSpeedTest(rtcB, "responder", {
        approve: async () => true,
      }),
    ]);
    await vi.runAllTimersAsync();
    expect((await results)[0]).toMatchObject({
      status: "rejected",
      reason: { code: "protocol" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("expires unanswered approval without consuming test traffic", async () => {
    const { a, b, rtcA, rtcB } = pair();
    const results = Promise.allSettled([
      runSpeedTest(rtcA, "initiator"),
      runSpeedTest(rtcB, "responder", {
        approve: () => new Promise(() => {}),
      }),
    ]);
    await vi.runAllTimersAsync();
    for (const result of await results) {
      expect(result).toMatchObject({
        status: "rejected",
        reason: { code: "declined" },
      });
    }
    expect(a.payloadBytes + b.payloadBytes).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects unreliable or unordered channels", async () => {
    const { a, rtcA } = pair();
    a.ordered = false;
    const result = runSpeedTest(rtcA, "initiator").catch(
      (error) => error,
    );
    await vi.runAllTimersAsync();
    expect(await result).toMatchObject({
      code: "protocol",
    });
    expect(a.closeCalls).toBe(1);
  });
});
