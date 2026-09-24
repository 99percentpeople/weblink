import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("@/libs/domain/utils/encrypt/e2e", () => ({
  hashPassword: vi.fn(async () => "client-password-hash"),
  comparePasswordHash: vi.fn(async () => true),
  encryptData: vi.fn(
    async (_password: string, data: unknown) => data,
  ),
  decryptData: vi.fn(
    async (_password: string, data: unknown) => data,
  ),
}));

import { WebSocketClientService } from "@/libs/infrastructure/signaling/client/ws-client-service";
import { encryptData } from "@/libs/domain/utils/encrypt/e2e";
import type { ClientServiceInitOptions } from "@/libs/domain/client";
import {
  getReconnectDelayMs,
  WEBSOCKET_CONNECTION_TIMEOUT_MS,
  WEBSOCKET_JOIN_ACK_TIMEOUT_MS,
} from "@/libs/infrastructure/signaling/client/reconnect-policy";

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
const notice = vi.fn();
let browserWindow: EventTarget;
let online = true;

function createService(
  options: Partial<ClientServiceInitOptions> = {},
): WebSocketClientService {
  const service = new WebSocketClientService({
    onNotice: notice,
    roomId: "room-a",
    password: null,
    websocketUrl: "wss://socket.test/ws",
    client: {
      clientId: "local",
      name: "Local",
      avatar: null,
    },
    ...options,
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
  passwordHash: string | null = null,
): Promise<FakeWebSocket> {
  const connected = service.createClient();
  await flushMicrotasks();
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error("socket was not created");
  socket.accept(passwordHash);
  await connected;
  return socket;
}

beforeEach(() => {
  notice.mockClear();
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
  const installLocks = () => {
    const held = new Map<string, Promise<void>>();
    const channels = new Set<BroadcastChannel>();
    vi.stubGlobal(
      "BroadcastChannel",
      class extends EventTarget {
        constructor(readonly name: string) {
          super();
          channels.add(this as unknown as BroadcastChannel);
        }
        postMessage(data: unknown) {
          for (const channel of channels) {
            if (
              channel === (this as unknown) ||
              channel.name !== this.name
            )
              continue;
            queueMicrotask(() =>
              channel.dispatchEvent(
                new MessageEvent("message", { data }),
              ),
            );
          }
        }
        close() {
          channels.delete(
            this as unknown as BroadcastChannel,
          );
        }
      },
    );
    const request = vi.fn(
      async (
        name: string,
        options: LockOptions,
        callback: LockGrantedCallback<unknown>,
      ) => {
        await Promise.resolve();
        while (held.has(name)) {
          if (options.ifAvailable) return callback(null);
          await new Promise<void>((resolve, reject) => {
            const abort = () =>
              reject(
                new DOMException("Aborted", "AbortError"),
              );
            if (options.signal?.aborted) {
              abort();
              return;
            }
            options.signal?.addEventListener(
              "abort",
              abort,
              { once: true },
            );
            void held
              .get(name)!
              .then(resolve)
              .finally(() =>
                options.signal?.removeEventListener(
                  "abort",
                  abort,
                ),
              );
          });
        }
        if (options.signal?.aborted)
          throw new DOMException("Aborted", "AbortError");
        let release!: () => void;
        held.set(
          name,
          new Promise<void>((resolve) => {
            release = resolve;
          }),
        );
        try {
          return await callback({
            name,
            mode: "exclusive",
          });
        } finally {
          held.delete(name);
          release();
        }
      },
    );
    Object.assign(navigator, { locks: { request } });
    return { held, request };
  };

  it("hands ownership to the requested tab only after the previous connection exits", async () => {
    installLocks();
    const previous = createService();
    const first = await connectService(previous);
    const sender = previous.createSender("remote")!;
    const current = createService();
    const joined = current.createClient({ takeover: true });
    await flushMicrotasks(32);
    expect(first.readyState).toBe(FakeWebSocket.CLOSED);
    expect(sender.status).toBe("closed");
    expect(notice).toHaveBeenCalledWith("tab-replaced");
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1].accept();
    await joined;
    browserWindow.dispatchEvent(new Event("online"));
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("times out without stealing from an unresponsive page", async () => {
    vi.useFakeTimers();
    const { held } = installLocks();
    const first = await connectService(createService());
    vi.spyOn(
      BroadcastChannel.prototype,
      "postMessage",
    ).mockImplementation(() => {});
    const joined = createService().createClient({
      takeover: true,
    });
    const failed = expect(joined).rejects.toThrow(
      "Room takeover timed out",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await failed;
    expect(first.readyState).toBe(FakeWebSocket.OPEN);
    expect(held.size).toBe(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("rejects a concurrent tab before opening a socket, retains ownership during reconnect and releases on leave", async () => {
    const { held } = installLocks();
    const firstService = createService();
    const duplicate = createService();
    const connected = firstService.createClient();
    expect(firstService.createClient()).toBe(connected);
    await expect(duplicate.createClient()).rejects.toThrow(
      "Room is already open in another tab",
    );
    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(1);
    const first = FakeWebSocket.instances[0];
    first.accept();
    await connected;
    first.serverClose();
    await flushMicrotasks();
    await expect(duplicate.createClient()).rejects.toThrow(
      "Room is already open in another tab",
    );
    expect(FakeWebSocket.instances).toHaveLength(2);
    firstService.close();
    await flushMicrotasks();
    expect(held.size).toBe(0);
    await connectService(duplicate);
    expect(FakeWebSocket.instances).toHaveLength(3);
    duplicate.close();
    await flushMicrotasks();
    expect(held.size).toBe(0);
  });

  it("allows different rooms and identities to connect independently", async () => {
    const { held } = installLocks();
    await connectService(createService());
    await connectService(
      createService({ roomId: "room-b" }),
    );
    await connectService(
      createService({
        client: {
          clientId: "other",
          name: "Other",
          avatar: null,
        },
      }),
    );
    expect(held.size).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("does not open a socket or retain a lock when closed during acquisition", async () => {
    const { held } = installLocks();
    const service = createService();
    const pending = service.createClient();
    service.close();
    await expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    await flushMicrotasks();
    expect(held.size).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("releases ownership after a failed initial connection", async () => {
    const { held } = installLocks();
    const service = createService();
    const connected = service.createClient();
    const failed =
      expect(connected).rejects.toThrow("socket closed");
    await flushMicrotasks();
    FakeWebSocket.instances[0].serverClose();
    await failed;
    await flushMicrotasks();
    expect(held.size).toBe(0);
    await connectService(createService());
  });

  it.each([
    [1000, "Session resumed elsewhere"],
    [1000, "Session replaced"],
    [1008, "Stale client session"],
  ] as const)(
    "stops reconnecting after replacement: %i %s",
    async (code, reason) => {
      vi.useFakeTimers();
      const service = createService();
      const socket = await connectService(service);
      const sender = service.createSender("remote")!;
      socket.serverClose(code, reason);
      await vi.advanceTimersByTimeAsync(60_000);
      browserWindow.dispatchEvent(new Event("online"));
      await flushMicrotasks();
      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(sender.status).toBe("closed");
      expect(notice).toHaveBeenCalledWith(
        "session-replaced",
      );
    },
  );

  it("installs the replacement socket before notifying connected listeners", async () => {
    const service = createService();
    const first = await connectService(service);
    const sender = service.createSender("remote")!;
    let sent: Promise<void> | undefined;
    sender.addEventListener("statuschange", (event) => {
      if (event.detail === "connected")
        sent = sender.sendSignal({
          type: "candidate",
          data: "candidate",
        });
    });
    first.serverClose();
    await flushMicrotasks();
    FakeWebSocket.instances[1].accept();
    await flushMicrotasks();
    await sent;
    expect(
      FakeWebSocket.instances[1].parsedMessages(),
    ).toContainEqual(
      expect.objectContaining({ type: "message" }),
    );
  });

  it.each(["socket", "sender"] as const)(
    "does not send after the %s closes during encryption",
    async (closed) => {
      const service = createService({
        password: "password",
      });
      const socket = await connectService(
        service,
        "server-password-hash",
      );
      const sender = service.createSender("remote")!;
      let encrypted!: (data: string) => void;
      vi.mocked(encryptData).mockImplementationOnce(
        () =>
          new Promise<string>((resolve) => {
            encrypted = resolve;
          }),
      );
      const send = vi.spyOn(socket, "send");
      const pending = sender.sendSignal({
        type: "candidate",
        data: "candidate",
      });
      if (closed === "socket") socket.serverClose();
      else sender.close();
      encrypted("encrypted");
      await expect(pending).rejects.toThrow(
        "socket is not open",
      );
      expect(send).not.toHaveBeenCalled();
    },
  );

  it("delegates room notices to presentation without English UI strings", async () => {
    await connectService(createService());
    expect(notice).toHaveBeenCalledOnce();
    expect(notice).toHaveBeenCalledWith("room-unprotected");
  });
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

  it.each([false, true])(
    "can create senders while replaying membership after join (resume=%s)",
    async (resume) => {
      const service = createService();
      let joining: Promise<void> | undefined;
      if (resume) {
        const first = await connectService(service);
        first.serverClose();
      } else joining = service.createClient();
      FakeWebSocket.acknowledgeJoins = false;
      await flushMicrotasks();
      const socket = FakeWebSocket.instances.at(-1)!;
      socket.accept();
      await flushMicrotasks();
      const errors: unknown[] = [];
      const senders: unknown[] = [];
      service.listenForJoin((client) => {
        try {
          senders.push(
            service.createSender(client.clientId),
          );
        } catch (error) {
          errors.push(error);
        }
      });
      socket.receive({
        type: "join",
        data: { clientId: "remote", createdAt: 1 },
      });
      expect(senders).toHaveLength(0);
      socket.receive({
        type: "joined",
        data: { protocolVersion: 2, resumed: resume },
      });
      await joining;
      await flushMicrotasks();
      expect(errors).toEqual([]);
      expect(senders).toHaveLength(1);
      expect(senders[0]).toMatchObject({
        status: "connected",
      });
    },
  );

  it("retires old membership when the server cannot resume the room session", async () => {
    const service = createService();
    const first = await connectService(service);
    const peer = { clientId: "remote", createdAt: 1 };
    first.receive({ type: "join", data: peer });
    const oldSender = service.createSender("remote")!;
    const onLeave = vi.fn(() =>
      service.removeSender("remote"),
    );
    service.listenForLeave(onLeave);
    first.serverClose();
    FakeWebSocket.acknowledgeJoins = false;
    await flushMicrotasks();
    const second = FakeWebSocket.instances.at(-1)!;
    second.accept();
    await flushMicrotasks();
    second.receive({
      type: "joined",
      data: { protocolVersion: 2, resumed: false },
    });
    await flushMicrotasks();
    expect(onLeave).toHaveBeenCalledOnce();
    expect(oldSender.status).toBe("closed");
    const onJoin = vi.fn((client) =>
      service.createSender(client.clientId),
    );
    service.listenForJoin(onJoin);
    second.receive({ type: "join", data: peer });
    expect(onJoin).toHaveBeenCalledOnce();
    expect(onJoin.mock.results[0].value).toMatchObject({
      status: "connected",
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
