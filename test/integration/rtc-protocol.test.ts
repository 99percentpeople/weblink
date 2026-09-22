import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  RtcProtocol,
  type WebRtcProtocol,
} from "@/libs/application/rtc/rtc-protocol";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import {
  FakeRtcTransport,
  makeSession,
  flushRtc,
  deferred,
} from "../support/rtc-transport";

const protocols: WebRtcProtocol[] = [];
const create = (transport = new FakeRtcTransport()) => {
  const protocol = new RtcProtocol(transport);
  protocols.push(protocol);
  return { protocol, transport };
};
const watch = <T>(promise: Promise<T>) => {
  void promise.catch(() => {});
  return promise;
};
const local = makeSession();
const remote = makeSession("b", "a");
const text = (id = "m1") =>
  createSessionMessage(
    remote,
    "send-text",
    { data: "hello" },
    { id, createdAt: 1 },
  );
const ack = (
  id = "m1",
  mode: "send" | "receive" = "receive",
) => createSessionMessage(remote, "ack", { mode }, { id });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  protocols
    .splice(0)
    .forEach((protocol) => protocol.dispose());
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("typed RTC calls", () => {
  it("creates the envelope and resolves the matching ACK", async () => {
    const { protocol, transport } = create();
    const prepared = vi.fn();
    const pending = protocol.call(
      local,
      "send-text",
      { data: "hello" },
      { onPrepared: prepared },
    );
    const request = transport.sendCalls[0]!.message;
    expect(request).toMatchObject({
      type: "send-text",
      client: "a",
      target: "b",
      data: "hello",
    });
    expect(request.id.length).toBeGreaterThan(0);
    expect(prepared).toHaveBeenCalledWith(request);
    await transport.emit(local, ack(request.id));
    await expect(pending).resolves.toMatchObject({
      type: "ack",
      id: request.id,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("automatically ACKs a registered handler", async () => {
    const { protocol, transport } = create();
    const handler = vi.fn();
    protocol.handle("send-text", handler);
    await transport.emit(local, text());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.sendCalls[0]!.message).toMatchObject({
      type: "ack",
      id: "m1",
      mode: "receive",
      client: "a",
      target: "b",
    });
  });

  it("takes the file request ACK mode from the protocol definition", async () => {
    const { protocol, transport } = create();
    protocol.handle("request-file", () => {});
    await transport.emit(
      local,
      createSessionMessage(remote, "request-file", {
        fid: "f",
        fileName: "a.txt",
        fileSize: 10,
        chunkSize: 4,
        ranges: [[0, 2]],
        resume: false,
      }),
    );
    expect(transport.sendCalls[0]!.message).toMatchObject({
      type: "ack",
      mode: "send",
    });
  });

  it("rejects ambiguous duplicate handler registration", () => {
    const { protocol } = create();
    const off = protocol.handle("send-text", () => {});
    expect(() =>
      protocol.handle("send-text", () => {}),
    ).toThrow(/already registered/);
    off();
    expect(() =>
      protocol.handle("send-text", () => {}),
    ).not.toThrow();
  });

  it("deduplicates work and replays its ACK", async () => {
    const { protocol, transport } = create();
    const handler = vi.fn();
    protocol.handle("send-text", handler);
    await transport.emit(local, text());
    await transport.emit(local, text());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      transport.sendCalls.map((call) => call.message.type),
    ).toEqual(["ack", "ack"]);
  });

  it("does not ACK a duplicate while its handler is still running", async () => {
    const { protocol, transport } = create();
    const work = deferred<void>();
    const handler = vi.fn(() => work.promise);
    protocol.handle("send-text", handler);
    const first = transport.emit(local, text());
    await transport.emit(local, text());
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.sendCalls).toHaveLength(0);
    work.resolve();
    await first;
    expect(transport.sendCalls).toHaveLength(1);
  });

  it("starts reply timeout after asynchronous transport send completes", async () => {
    const { protocol, transport } = create();
    const sent = deferred<void>();
    transport.sendImpl = () => sent.promise;
    const pending = watch(
      protocol.call(
        local,
        "send-text",
        { data: "hello" },
        { timeoutMs: 100, id: "m1" },
      ),
    );
    let done = false;
    void pending.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    vi.advanceTimersByTime(6_000);
    await flushRtc();
    expect(done).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    sent.resolve();
    await flushRtc();
    vi.advanceTimersByTime(99);
    await flushRtc();
    expect(done).toBe(false);
    await transport.emit(local, ack());
    await expect(pending).resolves.toMatchObject({
      id: "m1",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a reply arriving synchronously during send without leaving timers", async () => {
    const { protocol, transport } = create();
    transport.sendImpl = (_session, message) =>
      transport.emit(local, ack(message.id));
    await expect(
      protocol.call(local, "send-text", { data: "fast" }),
    ).resolves.toMatchObject({ type: "ack" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns timeout and retries the unchanged request", async () => {
    const { protocol, transport } = create();
    const pending = watch(
      protocol.call(
        local,
        "send-text",
        { data: "retry" },
        { timeoutMs: 10, retries: 1, retryDelayMs: 5 },
      ),
    );
    await flushRtc();
    vi.advanceTimersByTime(10);
    await flushRtc();
    expect(transport.sendCalls).toHaveLength(1);
    vi.advanceTimersByTime(5);
    await flushRtc();
    expect(transport.sendCalls).toHaveLength(2);
    expect(transport.sendCalls[1]!.message).toBe(
      transport.sendCalls[0]!.message,
    );
    vi.advanceTimersByTime(10);
    await expect(pending).rejects.toMatchObject({
      code: "timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the retry delay so it cannot resend a replacement request with the same ID", async () => {
    const { protocol, transport } = create();
    const controller = new AbortController();
    const first = watch(
      protocol.call(
        local,
        "send-text",
        { data: "first" },
        {
          id: "m1",
          signal: controller.signal,
          timeoutMs: 10,
          retries: 1,
          retryDelayMs: 100,
        },
      ),
    );
    await flushRtc();
    vi.advanceTimersByTime(10);
    controller.abort();
    await expect(first).rejects.toMatchObject({
      code: "aborted",
    });
    const next = protocol.call(
      local,
      "send-text",
      { data: "next" },
      { id: "m1" },
    );
    await flushRtc();
    vi.advanceTimersByTime(101);
    await flushRtc();
    expect(transport.sendCalls).toHaveLength(2);
    await transport.emit(local, ack());
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a duplicate pending call without invoking local preparation twice", async () => {
    const { protocol, transport } = create();
    const onPrepared = vi.fn();
    const first = protocol.call(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1", onPrepared },
    );
    await expect(
      protocol.call(
        local,
        "send-text",
        { data: "hello" },
        { id: "m1", onPrepared },
      ),
    ).rejects.toMatchObject({ code: "already-pending" });
    expect(onPrepared).toHaveBeenCalledTimes(1);
    await transport.emit(local, ack());
    await first;
  });

  it("isolates the same request ID across peers and checks ACK direction", async () => {
    const { protocol, transport } = create();
    const other = makeSession("a", "c");
    const first = protocol.call(
      local,
      "send-text",
      { data: "B" },
      { id: "m1" },
    );
    const second = protocol.call(
      other,
      "send-text",
      { data: "C" },
      { id: "m1" },
    );
    let secondDone = false;
    void second.then(() => {
      secondDone = true;
    });
    await transport.emit(local, ack());
    await first;
    expect(secondDone).toBe(false);
    await transport.emit(
      other,
      createSessionMessage(
        makeSession("c", "a"),
        "ack",
        { mode: "receive" },
        { id: "m1" },
      ),
    );
    await second;
  });

  it("isolates incoming deduplication across peers", async () => {
    const { protocol, transport } = create();
    const handler = vi.fn();
    protocol.handle("send-text", handler);
    await transport.emit(local, text());
    await transport.emit(makeSession("a", "c"), {
      ...text(),
      client: "c",
    });
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("ignores a spoofed sender and an unexpected ACK mode", async () => {
    const { protocol, transport } = create();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = protocol.call(
      local,
      "send-text",
      { data: "hello" },
      { id: "m1" },
    );
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await transport.emit(local, { ...ack(), client: "c" });
    await transport.emit(local, { ...ack(), target: "c" });
    await transport.emit(local, ack("m1", "send"));
    expect(done).toBe(false);
    await transport.emit(local, ack());
    await pending;
  });

  it("rejects remote errors and send failures with distinct codes", async () => {
    const { protocol, transport } = create();
    const pending = watch(
      protocol.call(
        local,
        "send-text",
        { data: "hello" },
        { id: "m1" },
      ),
    );
    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "error",
        { error: "denied" },
        { id: "m1" },
      ),
    );
    await expect(pending).rejects.toMatchObject({
      code: "remote-error",
      message: "denied",
    });
    transport.sendImpl = () => {
      throw new Error("send broke");
    };
    await expect(
      protocol.call(local, "send-text", { data: "hello" }),
    ).rejects.toMatchObject({
      code: "send-failed",
      message: "send broke",
    });
  });

  it("replies with an error when the handler fails or is missing", async () => {
    const { protocol, transport } = create();
    protocol.handle("send-text", () => {
      throw new Error("no space");
    });
    await transport.emit(local, text());
    expect(transport.sendCalls[0]!.message).toMatchObject({
      type: "error",
      error: "no space",
      id: "m1",
    });
    await transport.emit(
      local,
      createSessionMessage(remote, "resume-file", {
        fid: "f",
      }),
    );
    expect(transport.sendCalls[1]!.message).toMatchObject({
      type: "error",
    });
  });

  it("aborts before send and during pending work", async () => {
    const { protocol, transport } = create();
    const controller = new AbortController();
    controller.abort();
    await expect(
      protocol.call(
        local,
        "send-text",
        { data: "hello" },
        { signal: controller.signal },
      ),
    ).rejects.toMatchObject({ code: "aborted" });
    expect(transport.sendCalls).toHaveLength(0);
    const active = new AbortController();
    const pending = watch(
      protocol.call(
        local,
        "send-text",
        { data: "hello" },
        { signal: active.signal },
      ),
    );
    active.abort();
    await expect(pending).rejects.toMatchObject({
      code: "aborted",
    });
    expect(
      transport.sendCalls[0]!.options!.signal!.aborted,
    ).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes pending requests immediately and never accepts replies from a retired session", async () => {
    const { protocol, transport } = create();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = watch(
      protocol.call(
        local,
        "send-text",
        { data: "old" },
        { id: "m1" },
      ),
    );
    transport.close(local);
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
    const replacement = makeSession();
    const next = protocol.call(
      replacement,
      "send-text",
      { data: "new" },
      { id: "m1" },
    );
    let done = false;
    void next.then(() => {
      done = true;
    });
    await transport.emit(local, ack());
    expect(done).toBe(false);
    await transport.emit(replacement, ack());
    await next;
    await expect(
      protocol.call(local, "send-text", { data: "stale" }),
    ).rejects.toMatchObject({ code: "closed" });
  });

  it("aborts handler lifetime and suppresses late success replies on close", async () => {
    const { protocol, transport } = create();
    const work = deferred<void>();
    let signal: AbortSignal | undefined;
    protocol.handle("send-text", (context) => {
      signal = context.signal;
      return work.promise;
    });
    const incoming = transport.emit(local, text());
    transport.close(local);
    work.resolve();
    await incoming;
    expect(signal?.aborted).toBe(true);
    expect(transport.sendCalls).toHaveLength(0);
  });

  it("sends notifications without creating receipt timers", async () => {
    const { protocol, transport } = create();
    await protocol.notify(local, "stream-state", {
      mode: "media",
    });
    expect(transport.sendCalls[0]!.message.type).toBe(
      "stream-state",
    );
    expect(vi.getTimerCount()).toBe(0);
    const handler = vi.fn();
    protocol.on("stream-state", handler);
    await transport.emit(
      local,
      createSessionMessage(remote, "stream-state", {
        mode: "media",
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.sendCalls).toHaveLength(1);
  });

  it("ignores malformed network messages before dispatch", async () => {
    const { protocol, transport } = create();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = vi.fn();
    protocol.handle("send-text", handler);
    for (const message of [
      null,
      {},
      { ...text(), data: 42 },
      { ...text(), client: "c" },
    ]) {
      await transport.emit(
        local,
        message as SessionMessage,
      );
    }
    expect(handler).not.toHaveBeenCalled();
    expect(transport.sendCalls).toHaveLength(0);
  });

  it("disposes all listeners, pending timers and calls", async () => {
    const { protocol, transport } = create();
    const pending = watch(
      protocol.call(local, "send-text", { data: "hello" }),
    );
    await flushRtc();
    protocol.dispose();
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
    expect(transport.handlers.size).toBe(0);
    expect(transport.closedHandlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("typed file-list responses", () => {
  const storage = [
    {
      id: "f",
      fileName: "a.txt",
      fileSize: 10,
      chunkSize: 4,
    },
  ];

  it("returns data, not an early ACK, and re-ACKs repeated storage responses", async () => {
    const { protocol, transport } = create();
    const pending = protocol.call(
      local,
      "request-storage",
      {},
      { id: "m1" },
    );
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await transport.emit(local, ack());
    expect(done).toBe(false);
    const response = createSessionMessage(
      remote,
      "storage",
      { data: storage },
      { id: "m1" },
    );
    await transport.emit(local, response);
    await expect(pending).resolves.toEqual(storage);
    await transport.emit(local, {
      ...response,
      createdAt: response.createdAt + 1,
    });
    expect(
      transport.sendCalls.map((call) => call.message.type),
    ).toEqual(["request-storage", "ack", "ack"]);
  });

  it("adapts a handler's returned data to the existing storage/ACK exchange", async () => {
    const { protocol, transport } = create();
    const handler = vi.fn(() => storage);
    protocol.handle("request-storage", handler);
    const request = createSessionMessage(
      remote,
      "request-storage",
      {},
      { id: "m1" },
    );
    const receiving = transport.emit(local, request);
    await flushRtc();
    expect(transport.sendCalls[0]!.message).toMatchObject({
      type: "storage",
      id: "m1",
      data: storage,
    });
    expect(transport.sendCalls).toHaveLength(1);
    await transport.emit(local, ack());
    await receiving;
    expect(transport.sendCalls[1]!.message.type).toBe(
      "ack",
    );
    // A duplicate original request replays its response without re-running the handler.
    const duplicate = transport.emit(local, request);
    await flushRtc();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(transport.sendCalls[2]!.message.type).toBe(
      "storage",
    );
    await transport.emit(local, ack());
    await duplicate;
  });

  it("performs a full two-peer request/response with no leftover timers", async () => {
    const a = create();
    const b = create();
    a.transport.sendImpl = (_session, message) => {
      void b.transport.emit(remote, message);
    };
    b.transport.sendImpl = (_session, message) => {
      void a.transport.emit(local, message);
    };
    b.protocol.handle("request-storage", () => storage);
    await expect(
      a.protocol.call(local, "request-storage", {}),
    ).resolves.toEqual(storage);
    await flushRtc();
    expect(
      a.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["request-storage", "ack"]);
    expect(
      b.transport.sendCalls.map(
        (call) => call.message.type,
      ),
    ).toEqual(["storage", "ack"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("supports the nested reverse file request used by resume", async () => {
    const a = create();
    const b = create();
    a.transport.sendImpl = (_session, message) => {
      void b.transport.emit(remote, message);
    };
    b.transport.sendImpl = (_session, message) => {
      void a.transport.emit(local, message);
    };
    a.protocol.handle("request-file", () => {});
    b.protocol.handle(
      "resume-file",
      async ({ message, signal }) => {
        await b.protocol.call(
          remote,
          "request-file",
          {
            fid: message.fid,
            fileName: "a.txt",
            fileSize: 10,
            chunkSize: 4,
            resume: true,
          },
          { id: message.id, signal },
        );
      },
    );
    await expect(
      a.protocol.call(
        local,
        "resume-file",
        { fid: "f" },
        { id: "m1" },
      ),
    ).resolves.toMatchObject({
      type: "ack",
      mode: "receive",
    });
    await flushRtc();
    expect(vi.getTimerCount()).toBe(0);
  });
});
