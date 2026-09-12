import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/libs/core/utils/encrypt/e2e", () => ({
  hashPassword: vi.fn(async () => "client-password-hash"),
  comparePasswordHash: vi.fn(async () => true),
  encryptData: vi.fn(
    async (_password: string, data: unknown) => data,
  ),
  decryptData: vi.fn(
    async (_password: string, data: unknown) => data,
  ),
}));

vi.mock("solid-sonner", () => ({
  toast: {
    error: vi.fn(),
    warning: vi.fn(),
  },
}));

import { WebSocketClientService } from "@/libs/core/services/client/ws-client-service";
import {
  getReconnectDelayMs,
  WEBSOCKET_CONNECTION_TIMEOUT_MS,
  WEBSOCKET_JOIN_ACK_TIMEOUT_MS,
} from "@/libs/core/services/client/reconnect-policy";

function closeEvent(code: number, reason: string): Event {
  const event = new Event("close");
  Object.defineProperties(event, {
    code: { value: code },
    reason: { value: reason },
  });
  return event;
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static acknowledgeJoins = true;

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("socket is not open");
    }
    const serialized = String(data);
    this.sent.push(serialized);

    const message = JSON.parse(serialized) as Record<
      string,
      any
    >;
    if (
      message.type === "join" &&
      FakeWebSocket.acknowledgeJoins
    ) {
      queueMicrotask(() => {
        if (this.readyState !== FakeWebSocket.OPEN) return;
        this.receive({
          type: "joined",
          data: {
            protocolVersion: 2,
            resumed: message.data?.resume === true,
          },
        });
      });
    }
  }

  close(code = 1000, reason = ""): void {
    if (
      this.readyState === FakeWebSocket.CLOSING ||
      this.readyState === FakeWebSocket.CLOSED
    ) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSING;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code, reason));
  }

  accept(passwordHash: string | null = null): void {
    if (this.readyState !== FakeWebSocket.CONNECTING) {
      throw new Error("socket is not connecting");
    }
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
    this.receive({
      type: "connected",
      data: passwordHash,
    });
  }

  receive(signal: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(signal),
      }),
    );
  }

  serverClose(code = 1006, reason = "network lost"): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(closeEvent(code, reason));
  }

  parsedMessages(): Array<Record<string, any>> {
    return this.sent.map(
      (message) =>
        JSON.parse(message) as Record<string, any>,
    );
  }
}

const services: WebSocketClientService[] = [];
let browserWindow: EventTarget;
let online = true;

function createService(): WebSocketClientService {
  const service = new WebSocketClientService({
    roomId: "room-a",
    password: null,
    websocketUrl: "wss://socket.test/ws",
    client: {
      clientId: "local",
      name: "Local",
      avatar: null,
    },
  });
  services.push(service);
  return service;
}

async function flushMicrotasks(count = 8): Promise<void> {
  for (let index = 0; index < count; index++) {
    await Promise.resolve();
  }
}

async function connectService(
  service: WebSocketClientService,
): Promise<FakeWebSocket> {
  const connected = service.createClient();
  await flushMicrotasks();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("socket was not created");
  socket.accept();
  await connected;
  return socket;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  FakeWebSocket.acknowledgeJoins = true;
  browserWindow = new EventTarget();
  online = true;

  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("navigator", {
    get onLine() {
      return online;
    },
  });
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const service of services.splice(0)) {
    service.close();
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WebSocketClientService reconnect lifecycle", () => {
  it("does not register the deprecated unload event", () => {
    const addEventListener = vi.spyOn(
      browserWindow,
      "addEventListener",
    );

    createService();

    const registeredEvents =
      addEventListener.mock.calls.map(([event]) => event);
    expect(registeredEvents).toContain("beforeunload");
    expect(registeredEvents).toContain("online");
    expect(registeredEvents).not.toContain("unload");
  });

  it("resumes on one replacement socket and rebinds senders", async () => {
    const service = createService();
    const first = await connectService(service);
    const sender = service.createSender("remote");
    expect(sender).not.toBeNull();

    first.serverClose();
    (service as any).startReconnect();
    (service as any).startReconnect();
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(2);
    const second = FakeWebSocket.instances[1];
    second.accept();
    await flushMicrotasks();

    const join = second
      .parsedMessages()
      .find((message) => message.type === "join");
    expect(join?.data).toMatchObject({
      clientId: "local",
      resume: true,
    });
    expect(sender?.status).toBe("connected");

    await sender?.sendSignal({
      type: "offer",
      data: JSON.stringify({ sdp: "offer" }),
    });
    expect(second.parsedMessages()).toContainEqual(
      expect.objectContaining({
        type: "message",
        data: expect.objectContaining({
          type: "offer",
          targetClientId: "remote",
        }),
      }),
    );
  });

  it("waits for the versioned join acknowledgement", async () => {
    FakeWebSocket.acknowledgeJoins = false;
    const service = createService();
    let resolved = false;
    const connected = service.createClient().then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];

    socket.accept();
    await flushMicrotasks();
    expect(resolved).toBe(false);
    expect(socket.parsedMessages()).toContainEqual(
      expect.objectContaining({ type: "join" }),
    );

    socket.receive({
      type: "joined",
      data: { protocolVersion: 2, resumed: false },
    });
    await connected;
    expect(resolved).toBe(true);
  });

  it("buffers signaling until a resumed room join is acknowledged", async () => {
    const service = createService();
    const first = await connectService(service);
    const sender = service.createSender("remote")!;
    const onSignal = vi.fn();
    sender.addEventListener("signal", onSignal);
    FakeWebSocket.acknowledgeJoins = false;

    first.serverClose();
    await flushMicrotasks();
    const second = FakeWebSocket.instances[1];
    second.accept();
    await flushMicrotasks();
    second.receive({
      type: "message",
      data: {
        type: "offer",
        clientId: "remote",
        targetClientId: "local",
        data: JSON.stringify({ sdp: "cached-offer" }),
      },
    });
    await flushMicrotasks();
    expect(onSignal).not.toHaveBeenCalled();

    second.receive({
      type: "joined",
      data: { protocolVersion: 2, resumed: true },
    });
    await flushMicrotasks();

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0].detail).toMatchObject({
      type: "offer",
      data: { sdp: "cached-offer" },
    });
  });

  it("holds peer signals that arrive before sender creation", async () => {
    FakeWebSocket.acknowledgeJoins = false;
    const service = createService();
    const connected = service.createClient();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];
    socket.accept();
    await flushMicrotasks();

    socket.receive({
      type: "message",
      data: {
        type: "candidate",
        clientId: "remote",
        targetClientId: "local",
        data: JSON.stringify({ candidate: "candidate-a" }),
      },
    });
    socket.receive({
      type: "joined",
      data: { protocolVersion: 2, resumed: false },
    });
    await connected;

    const sender = service.createSender("remote")!;
    const onSignal = vi.fn();
    sender.addEventListener("signal", onSignal);
    await flushMicrotasks();

    expect(onSignal).toHaveBeenCalledTimes(1);
    expect(onSignal.mock.calls[0][0].detail).toMatchObject({
      type: "candidate",
      data: { candidate: "candidate-a" },
    });
  });

  it("falls back when a legacy server does not acknowledge joins", async () => {
    vi.useFakeTimers();
    FakeWebSocket.acknowledgeJoins = false;
    const service = createService();
    let resolved = false;
    const connected = service.createClient().then(() => {
      resolved = true;
    });
    await flushMicrotasks();
    FakeWebSocket.instances[0].accept();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(
      WEBSOCKET_JOIN_ACK_TIMEOUT_MS - 1,
    );
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await connected;
    expect(resolved).toBe(true);
  });

  it("closes a timed-out socket and ignores its late handshake", async () => {
    vi.useFakeTimers();
    const service = createService();
    const connected = service.createClient();
    await flushMicrotasks();
    const socket = FakeWebSocket.instances[0];

    const rejection = expect(connected).rejects.toThrow(
      "connection timeout",
    );
    await vi.advanceTimersByTimeAsync(
      WEBSOCKET_CONNECTION_TIMEOUT_MS,
    );
    await rejection;

    expect(socket.readyState).toBe(FakeWebSocket.CLOSED);
    socket.receive({ type: "connected", data: null });
    await flushMicrotasks();
    expect(socket.parsedMessages()).toEqual([]);
  });

  it("keeps retrying beyond the previous three-attempt limit", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const service = createService();
    const first = await connectService(service);

    first.serverClose();
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(2);

    for (let attempt = 1; attempt <= 4; attempt++) {
      FakeWebSocket.instances.at(-1)?.serverClose();
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(
        getReconnectDelayMs(attempt, {
          random: () => 0,
        }),
      );
      await flushMicrotasks();
      expect(FakeWebSocket.instances).toHaveLength(
        attempt + 2,
      );
    }
  });

  it("cancels delayed retries when the service closes", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const service = createService();
    const first = await connectService(service);

    first.serverClose();
    await flushMicrotasks();
    const reconnecting = FakeWebSocket.instances.at(-1)!;
    reconnecting.serverClose();
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(2);

    service.close();
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("pauses while offline and retries immediately on online", async () => {
    const service = createService();
    const first = await connectService(service);
    online = false;

    first.serverClose();
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(1);

    online = true;
    browserWindow.dispatchEvent(new Event("online"));
    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(2);
  });
});

describe("reconnect backoff", () => {
  it("caps exponential delays and applies bounded jitter", () => {
    expect(
      getReconnectDelayMs(1, { random: () => 0 }),
    ).toBe(250);
    expect(
      getReconnectDelayMs(1, { random: () => 1 }),
    ).toBe(500);
    expect(
      getReconnectDelayMs(20, { random: () => 1 }),
    ).toBe(15_000);
  });
});
