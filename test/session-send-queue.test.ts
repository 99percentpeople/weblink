import { describe, expect, it } from "vitest";
import { PeerSession } from "@/libs/core/session";
import type { SignalingService } from "@/libs/core/signaling";
import type { SendTextMessage } from "@/libs/application/rtc/rtc-protocol";

if (typeof window === "undefined") {
  (globalThis as any).window = {
    addEventListener: () => {},
    removeEventListener: () => {},
    setTimeout,
    clearTimeout,
  };
}

if (typeof document === "undefined") {
  (globalThis as any).document = {
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

const makeSender = (
  clientId: string,
  targetClientId: string,
): SignalingService =>
  ({
    clientId,
    targetClientId,
    get status() {
      return "connected";
    },
    sendSignal: async () => {},
    addEventListener: ((..._args: any[]) => {}) as any,
    removeEventListener: ((..._args: any[]) => {}) as any,
    close: () => {},
  }) as SignalingService;

describe("PeerSession send queue", () => {
  it("queues messages until the channel is open", async () => {
    const sender = makeSender("a", "b");
    const session = new PeerSession(sender, {
      polite: false,
    });

    const sendCalls: string[] = [];
    const channel = {
      readyState: "connecting",
      send: (data: string) => {
        sendCalls.push(data);
      },
      close: () => {},
    } as unknown as RTCDataChannel;

    (session as any).messageChannel = channel;

    const msg = {
      id: "m1",
      type: "send-text",
      createdAt: 1,
      client: "a",
      target: "b",
      data: "hello",
    } satisfies SendTextMessage;

    const first = session.sendMessage(msg);
    const duplicate = session.sendMessage(msg);

    expect(sendCalls).toHaveLength(0);
    expect((session as any).messageSendQueue.size).toBe(1);

    (channel as any).readyState = "open";
    (session as any).flushOutgoingQueue();

    expect(sendCalls).toHaveLength(1);
    expect(JSON.parse(sendCalls[0]!)).toMatchObject(msg);
    await Promise.all([first, duplicate]);
    session.close();
    expect((session as any).messageSendQueue.size).toBe(0);
  });

  it("sends immediately when the channel is open", async () => {
    const sender = makeSender("a", "b");
    const session = new PeerSession(sender, {
      polite: false,
    });

    const sendCalls: string[] = [];
    const channel = {
      readyState: "open",
      send: (data: string) => {
        sendCalls.push(data);
      },
      close: () => {},
    } as unknown as RTCDataChannel;

    (session as any).messageChannel = channel;

    const msg = {
      id: "m2",
      type: "send-text",
      createdAt: 1,
      client: "a",
      target: "b",
      data: "hi",
    } satisfies SendTextMessage;

    await session.sendMessage(msg);

    expect(sendCalls).toHaveLength(1);
    expect((session as any).messageSendQueue.size).toBe(0);
    session.close();
  });
});
