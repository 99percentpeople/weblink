// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RoomMessagingService,
  type RoomChatScope,
  type RoomDeliveryStatus,
} from "@/libs/application/messaging/room-messaging-service";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "@/libs/domain/session";
import type { TextMessage } from "@/libs/domain/message";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "../support/rtc-transport";

class MemoryMessages {
  readonly messages = new Map<string, TextMessage>();
  readonly statuses: {
    id: string;
    peer: string;
    status: RoomDeliveryStatus;
  }[] = [];
  beforePut?: () => Promise<void>;
  async putRoomMessage(
    message: TextMessage,
  ): Promise<boolean> {
    await this.beforePut?.();
    const previous = this.messages.get(message.id);
    if (previous) {
      if (
        previous.client !== message.client ||
        previous.conversationId !==
          message.conversationId ||
        previous.data !== message.data
      )
        throw new Error("Conflicting room message ID");
      return false;
    }
    this.messages.set(message.id, structuredClone(message));
    return true;
  }
  async setRoomDelivery(
    id: string,
    peer: string,
    status: RoomDeliveryStatus,
  ): Promise<void> {
    this.messages.get(id)!.deliveries![peer] = status;
    this.statuses.push({ id, peer, status });
  }
}

type Node = {
  id: string;
  transport: FakeRtcTransport;
  protocol: P2PProtocol<PeerSession>;
  state: {
    room: RoomChatScope | null;
    sessions: PeerSession[];
  };
  store: MemoryMessages;
  service?: RoomMessagingService;
};
const nodes: Node[] = [];
const room = (id = "meeting"): RoomChatScope => ({
  roomId: id,
  namespace: "test-server",
  conversationId: `room:test-server:${id}`,
});

function node(
  id: string,
  legacy = false,
  avatar: string | null = null,
): Node {
  const transport = new FakeRtcTransport();
  const protocol = new P2PProtocol(transport);
  const state = {
    room: room() as RoomChatScope | null,
    sessions: [] as PeerSession[],
  };
  const store = new MemoryMessages();
  const service = legacy
    ? undefined
    : new RoomMessagingService(protocol, {
        getRoom: () => state.room,
        getSessions: () => state.sessions,
        getLocalClient: () => ({
          clientId: id,
          name: `Name ${id}`,
          avatar,
        }),
        store,
      });
  const result = {
    id,
    transport,
    protocol,
    state,
    store,
    service,
  };
  nodes.push(result);
  return result;
}

function connect(a: Node, b: Node, ready = true) {
  const leftEmitter =
    new MultiEventEmitter<PeerSessionEventMap>();
  const rightEmitter =
    new MultiEventEmitter<PeerSessionEventMap>();
  const left = {
    clientId: a.id,
    targetClientId: b.id,
    isMessageChannelReady: ready,
    addEventListener:
      leftEmitter.addEventListener.bind(leftEmitter),
  } as unknown as PeerSession;
  const right = {
    clientId: b.id,
    targetClientId: a.id,
    isMessageChannelReady: ready,
    addEventListener:
      rightEmitter.addEventListener.bind(rightEmitter),
  } as unknown as PeerSession;
  a.state.sessions.push(left);
  b.state.sessions.push(right);
  const leftPrevious = a.transport.sendImpl;
  const rightPrevious = b.transport.sendImpl;
  a.transport.sendImpl = (session, message, options) =>
    session === left
      ? b.transport.emit(right, structuredClone(message))
      : leftPrevious?.(session, message, options);
  b.transport.sendImpl = (session, message, options) =>
    session === right
      ? a.transport.emit(left, structuredClone(message))
      : rightPrevious?.(session, message, options);
  return {
    left,
    right,
    setReady(value: boolean) {
      Object.assign(left, { isMessageChannelReady: value });
      Object.assign(right, {
        isMessageChannelReady: value,
      });
      leftEmitter.dispatchEvent(
        "messagechannelchange",
        value ? "ready" : "closed",
      );
      rightEmitter.dispatchEvent(
        "messagechannelchange",
        value ? "ready" : "closed",
      );
    },
    close() {
      a.state.sessions = a.state.sessions.filter(
        (session) => session !== left,
      );
      b.state.sessions = b.state.sessions.filter(
        (session) => session !== right,
      );
      a.transport.close(left);
      b.transport.close(right);
      leftEmitter.dispatchEvent("statuschange", "closed");
      rightEmitter.dispatchEvent("statuschange", "closed");
    },
  };
}

async function sync() {
  for (const participant of nodes)
    participant.service?.syncSessions();
  for (let count = 0; count < 4; count++) await flushRtc();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const participant of nodes.splice(0)) {
    participant.service?.dispose();
    participant.protocol.dispose();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("online room messaging", () => {
  it("rejects sending without online recipients before creating a history entry", async () => {
    const a = node("a");
    await expect(
      a.service!.send("Nobody online"),
    ).rejects.toThrow(/participants are online/);
    expect(a.store.messages.size).toBe(0);
  });

  it("stores one logical message and delivers independently to two online participants", async () => {
    const a = node("a"),
      b = node("b"),
      c = node("c"),
      offline = node("offline");
    connect(a, b);
    connect(a, c);
    connect(a, offline, false);
    await sync();
    expect(a.service!.capabilities).toMatchObject({
      b: "supported",
      c: "supported",
    });
    await a.service!.send("Hello room");
    expect(a.store.messages.size).toBe(1);
    const message = [...a.store.messages.values()][0];
    expect(message.deliveries).toEqual({
      b: "delivered",
      c: "delivered",
    });
    expect(b.store.messages.get(message.id)).toMatchObject({
      data: "Hello room",
      client: "a",
      room: { roomId: "meeting", senderName: "Name a" },
    });
    expect(c.store.messages.has(message.id)).toBe(true);
    expect(offline.store.messages.size).toBe(0);
    expect(
      a.transport.sendCalls.filter(
        (call) => call.message.type === "send-text",
      ),
    ).toHaveLength(0);
  });

  it("keeps a large sender avatar local instead of expanding every text frame", async () => {
    const avatar = `data:image/png;base64,${"a".repeat(200_000)}`;
    const a = node("a", false, avatar),
      b = node("b");
    connect(a, b);
    await sync();
    await a.service!.send("Small text");
    const outgoing = [...a.store.messages.values()][0];
    expect(outgoing.room!.senderAvatar).toBe(avatar);
    const frame = a.transport.sendCalls.find(
      (call) => call.message.type === "send-room-text",
    )!.message;
    expect(frame).toMatchObject({
      senderAvatar: null,
      data: "Small text",
    });
    expect(JSON.stringify(frame).length).toBeLessThan(
      1_000,
    );
    expect(outgoing.deliveries).toEqual({ b: "delivered" });
  });

  it("keeps recipient failures separate and retries only the original failed peers", async () => {
    const a = node("a"),
      b = node("b"),
      c = node("c");
    connect(a, b);
    connect(a, c);
    await sync();
    const route = a.transport.sendImpl!;
    a.transport.sendImpl = (session, message, options) => {
      if (
        message.type === "send-room-text" &&
        session.targetClientId === "b"
      )
        throw new Error("broken link");
      return route(session, message, options);
    };
    await a.service!.send("Partial");
    const message = [...a.store.messages.values()][0];
    expect(message.deliveries).toEqual({
      b: "failed",
      c: "delivered",
    });
    const newcomer = node("newcomer");
    connect(a, newcomer);
    a.transport.sendImpl = (session, message, options) =>
      session.targetClientId === "newcomer"
        ? newcomer.transport.emit(
            newcomer.state.sessions[0],
            message,
          )
        : route(session, message, options);
    await sync();
    await a.service!.retry(message);
    expect(message.deliveries).toEqual({
      b: "delivered",
      c: "delivered",
    });
    expect(newcomer.store.messages.size).toBe(0);
    expect(
      a.transport.sendCalls.filter(
        (call) =>
          call.message.type === "send-room-text" &&
          call.session.targetClientId === "c",
      ),
    ).toHaveLength(1);
  });

  it("does not delay a healthy recipient behind a peer waiting for a receipt", async () => {
    const a = node("a"),
      b = node("b"),
      c = node("c");
    connect(a, b);
    connect(a, c);
    await sync();
    const route = a.transport.sendImpl!;
    a.transport.sendImpl = (session, message, options) => {
      if (
        message.type === "send-room-text" &&
        session.targetClientId === "b"
      )
        return;
      return route(session, message, options);
    };
    const sending = a.service!.send("No head-of-line wait");
    await flushRtc();
    await flushRtc();
    const message = [...a.store.messages.values()][0];
    expect(message.deliveries).toEqual({
      b: "sending",
      c: "delivered",
    });
    await vi.advanceTimersByTimeAsync(5_001);
    await sending;
    expect(message.deliveries).toEqual({
      b: "failed",
      c: "delivered",
    });
  });

  it("marks a legacy client unsupported without sending a private-chat fallback", async () => {
    const a = node("a"),
      legacy = node("legacy", true);
    connect(a, legacy);
    await sync();
    await a.service!.send("New protocol only");
    expect(
      [...a.store.messages.values()][0].deliveries,
    ).toEqual({ legacy: "unsupported" });
    expect(
      a.transport.sendCalls.every(
        (call) => call.message.type === "room-capabilities",
      ),
    ).toBe(true);
  });

  it("bounds negotiation when an older validator silently drops unknown message types", async () => {
    const a = node("a"),
      legacy = node("legacy", true);
    connect(a, legacy);
    a.transport.sendImpl = () => {};
    await sync();
    const sending = a.service!.send(
      "Unknown on old client",
    );
    await vi.advanceTimersByTimeAsync(2_501);
    await sending;
    expect(
      [...a.store.messages.values()][0].deliveries,
    ).toEqual({ legacy: "unsupported" });
    expect(
      a.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["room-capabilities", "room-capabilities"]);
  });

  it("negotiates after the other client's room becomes ready later", async () => {
    const a = node("a"),
      b = node("b");
    b.state.room = null;
    connect(a, b);
    await sync();
    expect(a.service!.capabilities.b).toBe("unsupported");
    b.state.room = room();
    await sync();
    expect(a.service!.capabilities.b).toBe("supported");
    expect(b.service!.capabilities.a).toBe("supported");
    await a.service!.send("Both ready now");
    expect(b.store.messages.size).toBe(1);
  });

  it("waits for the peer offer when its capability ACK arrives first on an unordered channel", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    const route = b.transport.sendImpl!;
    const held: SessionMessage[] = [];
    b.transport.sendImpl = (session, message, options) => {
      if (message.type === "room-capabilities") {
        held.push(message);
        return;
      }
      return route(session, message, options);
    };
    await sync();
    expect(a.service!.capabilities.b).toBe("checking");
    const sending = a.service!.send(
      "Offer may arrive later",
    );
    await flushRtc();
    expect(
      [...a.store.messages.values()][0].deliveries,
    ).toEqual({ b: "sending" });
    expect(held).toHaveLength(1);
    await a.transport.emit(link.left, held[0]);
    await sending;
    expect(
      [...a.store.messages.values()][0].deliveries,
    ).toEqual({ b: "delivered" });
    expect(b.store.messages.size).toBe(1);
  });

  it("waits for receiver persistence before reporting delivery and can retry persistence failures", async () => {
    const a = node("a"),
      b = node("b");
    connect(a, b);
    await sync();
    const write = deferred<void>();
    b.store.beforePut = () => write.promise;
    const sending = a.service!.send("Persist first");
    await flushRtc();
    const message = [...a.store.messages.values()][0];
    expect(message.deliveries).toEqual({ b: "sending" });
    write.reject(new Error("disk full"));
    await sending;
    expect(message.deliveries).toEqual({ b: "failed" });
    b.store.beforePut = undefined;
    await a.service!.retry(message);
    expect(message.deliveries).toEqual({ b: "delivered" });
    expect(b.store.messages.size).toBe(1);
  });

  it("preserves persistent deduplication after the peer session is replaced", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    await sync();
    const route = b.transport.sendImpl!;
    b.transport.sendImpl = (session, message, options) =>
      message.type === "ack"
        ? undefined
        : route(session, message, options);
    const sending = a.service!.send("Receipt lost");
    await flushRtc();
    await vi.advanceTimersByTimeAsync(5_001);
    await sending;
    const message = [...a.store.messages.values()][0];
    expect(b.store.messages.size).toBe(1);
    expect(message.deliveries!.b).toBe("failed");
    link.close();
    connect(a, b);
    await sync();
    await a.service!.retry(message);
    expect(message.deliveries!.b).toBe("delivered");
    expect(b.store.messages.size).toBe(1);
  });

  it("rejects stale room and data-channel epochs without inserting them in history", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    await sync();
    await a.service!.send("Original");
    const original = a.transport.sendCalls.find(
      (call) => call.message.type === "send-room-text",
    )!.message;
    link.setReady(false);
    link.setReady(true);
    await sync();
    await b.transport.emit(link.right, {
      ...original,
      id: "stale-epoch",
    });
    expect(b.store.messages.has("stale-epoch")).toBe(false);
    a.state.room = room("new");
    b.state.room = room("new");
    await sync();
    await b.transport.emit(link.right, {
      ...original,
      id: "stale-room",
    });
    expect(b.store.messages.has("stale-room")).toBe(false);
    await a.service!.send("New room");
    expect(
      [...b.store.messages.values()].at(-1),
    ).toMatchObject({
      conversationId: room("new").conversationId,
      data: "New room",
    });
  });

  it("does not accept a forged sender on an otherwise valid room envelope", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    await sync();
    await a.service!.send("Original");
    const original = a.transport.sendCalls.find(
      (call) => call.message.type === "send-room-text",
    )!.message;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await b.transport.emit(link.right, {
      ...original,
      id: "spoofed",
      client: "other",
    });
    expect(b.store.messages.has("spoofed")).toBe(false);
  });

  it("does not let a private message smuggle local room metadata past capability checks", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    await sync();
    const privateHandler = vi.fn();
    b.protocol.handle("send-text", privateHandler);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await b.transport.emit(link.right, {
      ...createSessionMessage(link.left, "send-text", {
        data: "Injected room history",
      }),
      conversationId: room().conversationId,
      room: {
        roomId: "meeting",
        senderName: "a",
        senderAvatar: null,
      },
    } as unknown as ReturnType<
      typeof createSessionMessage
    >);
    expect(privateHandler).not.toHaveBeenCalled();
    expect(b.store.messages.size).toBe(0);
  });

  it("marks pending sends failed when leaving and never sends them into a later room", async () => {
    const a = node("a"),
      b = node("b");
    connect(a, b);
    await sync();
    const delayed = deferred<void>();
    a.store.beforePut = () => delayed.promise;
    const sending = a.service!.send("Old room only");
    await flushRtc();
    a.state.room = room("new");
    a.service!.syncSessions();
    delayed.resolve();
    await sending;
    const message = [...a.store.messages.values()][0];
    expect(message.conversationId).toBe(
      room().conversationId,
    );
    expect(message.deliveries).toEqual({ b: "failed" });
    expect(b.store.messages.size).toBe(0);
    await expect(a.service!.retry(message)).rejects.toThrow(
      /active room/,
    );
  });

  it("does not resume an original send when its data channel reopens during local persistence", async () => {
    const a = node("a"),
      b = node("b");
    const link = connect(a, b);
    await sync();
    const delayed = deferred<void>();
    a.store.beforePut = () => delayed.promise;
    const sending = a.service!.send(
      "Explicit retry required",
    );
    await flushRtc();
    link.setReady(false);
    link.setReady(true);
    await sync();
    delayed.resolve();
    await sending;
    const message = [...a.store.messages.values()][0];
    expect(message.deliveries).toEqual({ b: "failed" });
    expect(b.store.messages.size).toBe(0);
    await a.service!.retry(message);
    expect(message.deliveries).toEqual({ b: "delivered" });
    expect(b.store.messages.size).toBe(1);
  });
});
