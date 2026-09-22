// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ChunkCache } from "@/libs/cache/chunk-cache";
import type { FileMetaData } from "@/libs/cache";
import type { FileTransferMessage } from "@/libs/core/message";
import type { PeerSession } from "@/libs/core/session";
import { FileTransferBase } from "@/libs/core/transfer/file-transfer-base";
import {
  TransferMode,
  type ProgressValue,
} from "@/libs/core/transfer/file-transferer";
import type { RtcChannelHandler } from "@/libs/application/rtc/rtc-service";
import type { SessionMessage } from "@/libs/core/protocol/messages";
import type { FileTransferStates } from "@/libs/application/transfer/file-transfer-state";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { FileTransferService } from "@/libs/application/transfer/file-transfer-service";
import { TransferRegistry } from "@/libs/application/transfer/transfer-registry";
import {
  bindTransferMessage,
  finishReceivedFile,
} from "@/libs/application/transfer/transfer-message-binding";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
  makeSession,
} from "./helpers/rtc-transport";

class TestChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  readonly protocol = "transfer";
  onmessage: unknown = null;
  bufferedAmount = 0;
  send = vi.fn();
  close = vi.fn(() => {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  });
  constructor(readonly label = "shared-0") {
    super();
  }
  rtc() {
    return this as unknown as RTCDataChannel;
  }
}

class TestTransfer extends FileTransferBase {
  sendFile = vi.fn(async () => {});
  setSendStatus = vi.fn(async () => {});
  initialize = vi.fn(async () => {});
  constructor(
    cache: ChunkCache,
    readonly mode: TransferMode,
  ) {
    super({ cache });
  }
  protected handleReceiveMessage(): void {}
  progress(value: ProgressValue): void {
    this.dispatchEvent("progress", value);
  }
  complete(): void {
    this.isComplete = true;
    this.dispatchEvent("complete", undefined);
  }
}

function cacheStub(id = "shared") {
  const file = new File(
    [new Uint8Array(100)],
    "shared.txt",
    { type: "text/plain" },
  );
  let info: FileMetaData = {
    id,
    fileName: file.name,
    fileSize: file.size,
    chunkSize: 64,
    file,
    isComplete: true,
  };
  const events = new EventTarget();
  const stub = {
    id,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener:
      events.removeEventListener.bind(events),
    getInfo: vi.fn(async () => info),
    setInfo: vi.fn(async (next: FileMetaData) => {
      info = { ...info, ...next };
    }),
    getReqRanges: vi.fn(
      async () => [[0, 1]] as [number, number][],
    ),
    flush: vi.fn(async () => {}),
    getFile: vi.fn(async () => file),
    cleanup: vi.fn(async () => {}),
  };
  return { stub, cache: stub as unknown as ChunkCache };
}

function fixture(automaticDeletion = false) {
  const messages: FileTransferMessage[] = [];
  const update = (
    id: string,
    apply: (m: FileTransferMessage) => void,
  ) => {
    const found = messages.find((m) => m.id === id);
    if (found) apply(found);
  };
  const track = (m: SessionMessage) => {
    if (m.type !== "send-file" && m.type !== "request-file")
      return;
    if (messages.some((item) => item.id === m.id)) return;
    messages.push({
      ...m,
      type: "file",
      status: "sending",
      transferStatus: "init",
      ...(m.type === "request-file"
        ? { client: m.target, target: m.client }
        : {}),
    });
  };
  const store = {
    messages,
    setSendMessage: vi.fn(track),
    retrySendMessage: vi.fn((m: SessionMessage) => {
      track(m);
      update(m.id, (item) => {
        item.status = "sending";
      });
    }),
    setReceiveMessage: vi.fn((m: SessionMessage) => {
      if (m.type === "ack")
        update(m.id, (item) => {
          item.status = "received";
        });
      else if (m.type === "error")
        update(m.id, (item) => {
          item.status = "error";
          item.error = m.error;
        });
      else track(m);
    }),
    updateTransferMessage: vi.fn(update),
  };
  const transport = new FakeRtcTransport();
  const channelHandlers = new Set<RtcChannelHandler>();
  const rtc = {
    onSessionClosed:
      transport.onSessionClosed.bind(transport),
    onChannel: (handler: RtcChannelHandler) => {
      channelHandlers.add(handler);
      return () => {
        channelHandlers.delete(handler);
      };
    },
  };
  const protocol = new RtcProtocol(transport);
  transport.sendImpl = async (session, message) => {
    if (
      ![
        "send-file",
        "request-file",
        "resume-file",
      ].includes(message.type)
    )
      return;
    await transport.emit(session, {
      type: "ack",
      id: message.id,
      createdAt: Date.now(),
      client: session.targetClientId,
      target: session.clientId,
      mode:
        message.type === "request-file"
          ? "send"
          : "receive",
    });
  };
  const caches = new Map<string, ChunkCache>();
  const cacheApi = {
    getCache: (id: string) => caches.get(id) ?? null,
    createCache: vi.fn(async (id?: string) => {
      const { cache } = cacheStub(
        id ?? crypto.randomUUID(),
      );
      caches.set(cache.id, cache);
      return cache;
    }),
  };
  const active: FileTransferStates = {};
  const registry = new TransferRegistry({
    createTransfer: ({ cache, mode }) =>
      new TestTransfer(cache, mode),
    publish: (id, value) => {
      if (value) active[id] = value;
      else delete active[id];
    },
    bind: (run, signal) =>
      bindTransferMessage(run, store, signal),
    complete: async (run, signal) => {
      if (run.transferer.mode === TransferMode.Receive)
        await finishReceivedFile(
          run.transferer.cache,
          run.messageId,
          store,
          signal,
        );
    },
    failed: (run, error) =>
      update(run.messageId, (item) => {
        item.transferStatus = "error";
        item.error = error.message;
      }),
    automaticCacheDeletion: () => automaticDeletion,
    reportError: vi.fn(),
    channelTimeoutMs: 1000,
  });
  const sessions = new Map<string, PeerSession>();
  const channels: TestChannel[] = [];
  const peer = (id: string) => {
    const session = makeSession("local", id);
    session.createChannel = vi.fn(async (label: string) => {
      const channel = new TestChannel(label);
      channels.push(channel);
      return channel.rtc();
    });
    sessions.set(id, session);
    return session;
  };
  const service = new FileTransferService({
    protocol,
    rtc,
    registry,
    caches: cacheApi,
    messages: store,
    messaging: new PeerMessagingService(protocol, store),
    getSession: (id) => sessions.get(id),
    getChunkSize: () => 64,
  });
  return {
    messages,
    store,
    transport,
    channelHandlers,
    protocol,
    caches,
    cacheApi,
    active,
    registry,
    sessions,
    channels,
    peer,
    service,
    emitChannel: async (
      session: PeerSession,
      channel: TestChannel,
    ) => {
      for (const handler of channelHandlers)
        await handler({ session, channel: channel.rtc() });
    },
    dispose: () => {
      service.dispose();
      protocol.dispose();
    },
  };
}

let cleanup: (() => void)[];
beforeEach(() => {
  cleanup = [];
  vi.useFakeTimers();
});
afterEach(() => {
  for (const fn of cleanup) fn();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(automaticDeletion = false) {
  const f = fixture(automaticDeletion);
  cleanup.push(f.dispose);
  return f;
}

describe("file workflow lifecycle regressions", () => {
  it("shares one cache with two peers and pauses only the selected peer", async () => {
    const f = setup();
    const a = f.peer("a"),
      b = f.peer("b");
    const { cache } = cacheStub();
    f.caches.set(cache.id, cache);
    await Promise.all([
      f.service.shareFile(a, cache.id),
      f.service.shareFile(b, cache.id),
    ]);
    const runA = f.registry.get(a, cache.id)!,
      runB = f.registry.get(b, cache.id)!;
    expect(runA.id).not.toBe(runB.id);
    expect(runA.messageId).not.toBe(runB.messageId);
    (runA.transferer as TestTransfer).progress({
      total: 100,
      received: 25,
    });
    (runB.transferer as TestTransfer).progress({
      total: 100,
      received: 70,
    });
    expect(
      f.messages.find((m) => m.id === runA.messageId)
        ?.progress?.received,
    ).toBe(25);
    expect(
      f.messages.find((m) => m.id === runB.messageId)
        ?.progress?.received,
    ).toBe(70);
    await f.service.pauseFile(a, cache.id);
    expect(f.registry.get(a, cache.id)).toBeUndefined();
    expect(f.registry.get(b, cache.id)).toBe(runB);
    expect(runB.transferer.channel?.readyState).toBe(
      "open",
    );
  });

  it("rejects duplicate same-peer starts without disturbing the active run", async () => {
    const f = setup();
    const a = f.peer("a");
    const { cache } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.shareFile(a, cache.id);
    const first = f.registry.get(a, cache.id);
    await expect(
      f.service.shareFile(a, cache.id),
    ).rejects.toThrow(/active/);
    expect(f.registry.get(a, cache.id)).toBe(first);
    expect(
      f.transport.sendCalls.filter(
        (item) => item.message.type === "send-file",
      ),
    ).toHaveLength(1);
  });

  it("never associates an unknown or retired peer's channel by file ID alone", async () => {
    const f = setup();
    const a = f.peer("a"),
      old = makeSession("local", "a");
    const { cache } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.shareFile(a, cache.id);
    const current = f.registry.get(a, cache.id)!;
    const before = current.transferer.channel;
    const stale = new TestChannel();
    await f.emitChannel(old, stale);
    const unknown = new TestChannel("unknown-0");
    await f.emitChannel(a, unknown);
    expect(stale.close).toHaveBeenCalled();
    expect(unknown.close).toHaveBeenCalled();
    expect(current.transferer.channel).toBe(before);
  });

  it("closes a late channel when the session exits during channel creation", async () => {
    const f = setup();
    const a = f.peer("a");
    const { cache } = cacheStub();
    f.caches.set(cache.id, cache);
    const late = deferred<RTCDataChannel>();
    a.createChannel = vi.fn(() => late.promise);
    const sending = f.service.shareFile(a, cache.id);
    const outcome = sending.catch((error: Error) => error);
    await flushRtc();
    expect(a.createChannel).toHaveBeenCalled();
    f.transport.close(a);
    expect(await outcome).toMatchObject({
      name: "AbortError",
    });
    const channel = new TestChannel();
    late.resolve(channel.rtc());
    await flushRtc();
    expect(channel.close).toHaveBeenCalled();
    expect(Object.keys(f.active)).toHaveLength(0);
  });

  it("does not send a stale request after a delayed cache read and session replacement", async () => {
    const f = setup();
    const a = f.peer("a");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    const delayed = deferred<FileMetaData>();
    stub.getInfo.mockImplementation(() => delayed.promise);
    const sending = f.service
      .shareFile(a, cache.id)
      .catch((error: Error) => error);
    f.peer("a");
    delayed.resolve({
      id: cache.id,
      fileName: "shared.txt",
      fileSize: 100,
      chunkSize: 64,
      file: new File(["a"], "shared.txt"),
    });
    expect(await sending).toMatchObject({
      name: "AbortError",
    });
    expect(f.transport.sendCalls).toHaveLength(0);
    expect(Object.keys(f.active)).toHaveLength(0);
  });

  it("updates by message ID even after earlier messages are removed", async () => {
    const f = setup();
    const a = f.peer("a"),
      b = f.peer("b");
    const { cache } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.shareFile(a, cache.id);
    await f.service.shareFile(b, cache.id);
    const run = f.registry.get(b, cache.id)!;
    f.messages.splice(0, 1);
    (run.transferer as TestTransfer).progress({
      total: 100,
      received: 42,
    });
    expect(f.messages).toHaveLength(1);
    expect(f.messages[0]).toMatchObject({
      id: run.messageId,
      progress: { received: 42 },
    });
    f.messages.splice(0, 1);
    expect(() =>
      (run.transferer as TestTransfer).progress({
        total: 100,
        received: 50,
      }),
    ).not.toThrow();
    expect(f.messages).toHaveLength(0);
  });

  it("holds shared cache deletion until every sending peer has finished", async () => {
    const f = setup(true);
    const a = f.peer("a"),
      b = f.peer("b");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    await Promise.all([
      f.service.shareFile(a, cache.id),
      f.service.shareFile(b, cache.id),
    ]);
    const runA = f.registry.get(a, cache.id)!,
      runB = f.registry.get(b, cache.id)!;
    (runA.transferer as TestTransfer).complete();
    await flushRtc();
    expect(stub.cleanup).not.toHaveBeenCalled();
    expect(f.registry.get(b, cache.id)).toBe(runB);
    (runB.transferer as TestTransfer).complete();
    await flushRtc();
    expect(stub.cleanup).toHaveBeenCalledTimes(1);
  });

  it("also retains the cache when one peer pauses before another peer completes", async () => {
    const f = setup(true);
    const a = f.peer("a"),
      b = f.peer("b");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    await Promise.all([
      f.service.shareFile(a, cache.id),
      f.service.shareFile(b, cache.id),
    ]);
    const runB = f.registry.get(b, cache.id)!;
    await f.service.pauseFile(a, cache.id);
    (runB.transferer as TestTransfer).complete();
    await flushRtc();
    expect(stub.cleanup).not.toHaveBeenCalled();
    const paused = f.messages.find(
      (message) => message.target === "a",
    )!;
    await f.service.retryFile(a, paused);
    (
      f.registry.get(a, cache.id)!
        .transferer as TestTransfer
    ).complete();
    await flushRtc();
    expect(stub.cleanup).toHaveBeenCalledTimes(1);
  });

  it("a preparing second peer also prevents automatic cache deletion", async () => {
    const f = setup(true);
    const a = f.peer("a"),
      b = f.peer("b");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.shareFile(a, cache.id);
    const delayed = deferred<FileMetaData>();
    stub.getInfo.mockImplementation(() => delayed.promise);
    const second = f.service.shareFile(b, cache.id);
    (
      f.registry.get(a, cache.id)!
        .transferer as TestTransfer
    ).complete();
    await flushRtc();
    expect(stub.cleanup).not.toHaveBeenCalled();
    delayed.resolve({
      id: cache.id,
      fileName: "shared.txt",
      fileSize: 100,
      chunkSize: 64,
      file: new File(["a"], "shared.txt"),
    });
    await second;
    expect(stub.cleanup).not.toHaveBeenCalled();
    (
      f.registry.get(b, cache.id)!
        .transferer as TestTransfer
    ).complete();
    await flushRtc();
    expect(stub.cleanup).toHaveBeenCalledTimes(1);
  });

  it("reserves a cache writer before asynchronous cache creation", async () => {
    const f = setup();
    const a = f.peer("a"),
      b = f.peer("b");
    const creation = deferred<ChunkCache>();
    f.cacheApi.createCache.mockImplementation(
      () => creation.promise,
    );
    const info = {
      id: "shared",
      fileName: "shared.txt",
      fileSize: 100,
      chunkSize: 64,
    };
    const first = f.service.requestFile(a, info);
    const firstOutcome = first.catch(
      (error: Error) => error,
    );
    await flushRtc();
    const second = f.service
      .requestFile(b, info)
      .catch((error: Error) => error);
    await flushRtc();
    expect(f.cacheApi.createCache).toHaveBeenCalledTimes(1);
    expect(await second).toBeInstanceOf(Error);
    creation.resolve(cacheStub().cache);
    expect(await firstOutcome).toBeUndefined();
    expect(f.registry.get(a, "shared")).toBeDefined();
    expect(f.registry.get(b, "shared")).toBeUndefined();
  });

  it("keeps cache assembly attached to the receiving run until it completes", async () => {
    const f = setup();
    const a = f.peer("a");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.requestFile(a, {
      id: cache.id,
      fileName: "shared.txt",
      fileSize: 100,
      chunkSize: 64,
    });
    const run = f.registry.get(a, cache.id)!;
    const assembled = deferred<File>();
    stub.getFile.mockImplementation(
      () => assembled.promise,
    );
    (run.transferer as TestTransfer).complete();
    await flushRtc();
    expect(f.registry.get(a, cache.id)).toBe(run);
    expect(f.messages[0].transferStatus).not.toBe(
      "complete",
    );
    assembled.resolve(new File(["done"], "shared.txt"));
    await flushRtc();
    expect(f.messages[0].transferStatus).toBe("complete");
    expect(f.registry.get(a, cache.id)).toBeUndefined();
  });

  it("ignores a cache assembly result after the receiving session was closed", async () => {
    const f = setup();
    const a = f.peer("a");
    const { cache, stub } = cacheStub();
    f.caches.set(cache.id, cache);
    await f.service.requestFile(a, {
      id: cache.id,
      fileName: "shared.txt",
      fileSize: 100,
      chunkSize: 64,
    });
    const run = f.registry.get(a, cache.id)!;
    const assembled = deferred<File>();
    stub.getFile.mockImplementation(
      () => assembled.promise,
    );
    (run.transferer as TestTransfer).complete();
    await flushRtc();
    f.service.closeSession(a);
    assembled.resolve(new File(["done"], "shared.txt"));
    await flushRtc();
    expect(f.messages[0].transferStatus).not.toBe(
      "complete",
    );
    expect(f.registry.get(a, cache.id)).toBeUndefined();
  });
});
