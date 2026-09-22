// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { FileTransferService } from "@/libs/application/transfer/file-transfer-service";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import type { RtcChannelHandler } from "@/libs/application/rtc/rtc-service";
import type { PeerSession } from "@/libs/domain/session";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { ChunkCache } from "@/libs/domain/file";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "./helpers/rtc-transport";
import {
  fakeCache,
  fakeChannel,
  fileMessage,
  fileSession,
  registryFixture,
} from "./helpers/file-transfer";

function setup() {
  const f = registryFixture();
  const transport = new FakeRtcTransport();
  const channelHandlers = new Set<RtcChannelHandler>();
  const protocol = new RtcProtocol(transport);
  const sessions = new Map<string, PeerSession>();
  const session = fileSession();
  sessions.set("peer", session);
  const caches = new Map<string, ChunkCache>();
  const cacheApi = {
    getCache: (id: string) => caches.get(id) ?? null,
    createCache: vi.fn(
      async (
        id = crypto.randomUUID(),
      ): Promise<ChunkCache> => {
        const cache = fakeCache(id);
        caches.set(id, cache);
        return cache;
      },
    ),
  };
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
  const service = new FileTransferService({
    protocol,
    rtc,
    registry: f.registry,
    caches: cacheApi,
    messages: f.messages,
    messaging: new PeerMessagingService(
      protocol,
      f.messages,
    ),
    getSession: (peerId) => sessions.get(peerId),
    getChunkSize: () => 1024,
  });
  const autoAck = () => {
    transport.sendImpl = async (peer, message) => {
      if (
        message.type === "send-file" ||
        message.type === "request-file"
      )
        await transport.emit(
          peer,
          createSessionMessage(
            {
              clientId: peer.targetClientId,
              targetClientId: peer.clientId,
            },
            "ack",
            {
              mode:
                message.type === "request-file"
                  ? "send"
                  : "receive",
            },
            { id: message.id },
          ),
        );
    };
  };
  const emitChannel = async (
    peer: PeerSession,
    channel: RTCDataChannel,
  ) => {
    for (const handler of channelHandlers)
      await handler({ session: peer, channel });
  };
  return {
    ...f,
    transport,
    protocol,
    sessions,
    session,
    caches,
    cacheApi,
    service,
    emitChannel,
    autoAck,
    dispose: () => {
      service.dispose();
      protocol.dispose();
    },
  };
}
let f: ReturnType<typeof setup>;
beforeEach(() => {
  vi.useFakeTimers();
  f = setup();
});
afterEach(async () => {
  f.dispose();
  await flushRtc();
  vi.useRealTimers();
});
const remote = {
  clientId: "peer",
  targetClientId: "local",
};
const payload = {
  fid: "file",
  fileName: "sample.bin",
  fileSize: 2048,
  chunkSize: 1024,
};

describe("file control handlers", () => {
  it("prepares a receiver before acknowledging send-file", async () => {
    const incoming = createSessionMessage(
      remote,
      "send-file",
      payload,
      { id: "incoming" },
    );
    await f.transport.emit(f.session, incoming);
    const run = f.registry.get(f.session, "file")!;
    expect(run).toBeDefined();
    expect(run.messageId).toBe("incoming");
    expect(run.transferer.mode).toBe(TransferMode.Receive);
    expect(f.created[0].initialize).toHaveBeenCalledOnce();
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({
      type: "ack",
      id: "incoming",
      mode: "receive",
    });
    const channel = fakeChannel();
    await f.emitChannel(f.session, channel);
    expect(run.transferer.channel).toBe(channel);
  });
  it("does not create two receiver caches while the first writer is still preparing", async () => {
    const pending = deferred<ChunkCache>();
    f.cacheApi.createCache.mockReturnValue(pending.promise);
    const first = f.transport.emit(
      f.session,
      createSessionMessage(remote, "send-file", payload, {
        id: "first",
      }),
    );
    await flushRtc();
    const other = fileSession("other");
    f.sessions.set("other", other);
    await f.transport.emit(
      other,
      createSessionMessage(
        { clientId: "other", targetClientId: "local" },
        "send-file",
        payload,
        { id: "second" },
      ),
    );
    expect(f.cacheApi.createCache).toHaveBeenCalledTimes(1);
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({ type: "error", id: "second" });
    pending.resolve(fakeCache());
    await first;
    expect(f.registry.get(f.session, "file")).toBeDefined();
    expect(f.registry.get(other, "file")).toBeUndefined();
  });
  it("initializes requested ranges before opening the sending side", async () => {
    f.caches.set("file", fakeCache());
    const incoming = createSessionMessage(
      remote,
      "request-file",
      { ...payload, ranges: [[1, 1]], resume: true },
      { id: "request" },
    );
    await f.transport.emit(f.session, incoming);
    const run = f.registry.get(f.session, "file")!;
    expect(run.transferer.mode).toBe(TransferMode.Send);
    expect(f.created[0].setSendStatus).toHaveBeenCalledWith(
      incoming,
    );
    expect(f.created[0].sendFile).not.toHaveBeenCalled();
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({ type: "ack", mode: "send" });
    await f.emitChannel(f.session, fakeChannel());
    expect(f.created[0].sendFile).toHaveBeenCalledWith([
      [1, 1],
    ]);
  });
  it("returns a remote error for an unavailable requested file", async () => {
    await f.transport.emit(
      f.session,
      createSessionMessage(
        remote,
        "request-file",
        { ...payload, resume: false },
        { id: "missing" },
      ),
    );
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({ type: "error", id: "missing" });
    expect(Object.keys(f.state)).toHaveLength(0);
  });
  it("propagates reverse-request failure instead of acknowledging resume", async () => {
    f.caches.set("file", fakeCache());
    f.transport.sendImpl = async (session, message) => {
      if (message.type === "request-file")
        await f.transport.emit(
          session,
          createSessionMessage(
            remote,
            "error",
            { error: "remote file gone" },
            { id: message.id },
          ),
        );
    };
    await f.transport.emit(
      f.session,
      createSessionMessage(
        remote,
        "resume-file",
        { fid: "file" },
        { id: "resume" },
      ),
    );
    expect(
      f.transport.sendCalls.at(-1)?.message,
    ).toMatchObject({ type: "error", id: "resume" });
    expect(
      f.transport.sendCalls.some(
        ({ message }) =>
          message.type === "ack" && message.id === "resume",
      ),
    ).toBe(false);
    expect(Object.keys(f.state)).toHaveLength(0);
  });
  it("allows the reverse request-file while an outgoing resume is waiting", async () => {
    f.caches.set("file", fakeCache());
    f.messages.messages.push(fileMessage("history"));
    f.transport.sendImpl = async (session, message) => {
      if (message.type !== "resume-file") return;
      await f.transport.emit(
        session,
        createSessionMessage(
          remote,
          "request-file",
          { ...payload, resume: true, ranges: [1] },
          { id: message.id },
        ),
      );
      await f.transport.emit(
        session,
        createSessionMessage(
          remote,
          "ack",
          { mode: "receive" },
          { id: message.id },
        ),
      );
    };
    await f.service.resumeFile(f.session, "file");
    expect(
      f.registry.get(f.session, "file")?.messageId,
    ).toBe("history");
    expect(
      f.transport.sendCalls.some(
        ({ message }) => message.type === "error",
      ),
    ).toBe(false);
  });
});

describe("file operation preparation and cancellation", () => {
  it("creates a new cache and sends a file using the shared protocol API", async () => {
    f.autoAck();
    await f.service.sendFile(
      f.session,
      new File([new Uint8Array(2048)], "new.bin"),
    );
    const request = f.transport.sendCalls.find(
      ({ message }) => message.type === "send-file",
    )!.message;
    expect(request).toMatchObject({
      client: "local",
      target: "peer",
      fileName: "new.bin",
      chunkSize: 1024,
    });
    expect(f.created[0].sendFile).toHaveBeenCalledOnce();
    expect(f.created[0].channel?.label).toBe(
      `${f.created[0].id}-0`,
    );
  });
  it("retries the selected incoming message, not newer history for the same file", async () => {
    f.autoAck();
    f.caches.set("file", fakeCache());
    const old = {
      ...fileMessage("old"),
      client: "peer",
      target: "local",
    };
    const newer = { ...old, id: "new", createdAt: 2 };
    f.messages.messages.push(old, newer);
    await f.service.retryFile(f.session, old);
    expect(
      f.registry.get(f.session, "file")?.messageId,
    ).toBe("old");
    expect(
      f.transport.sendCalls.find(
        ({ message }) => message.type === "request-file",
      )?.message.id,
    ).toBe("old");
    f.created[0].dispatchEvent("progress", {
      total: 2048,
      received: 512,
    });
    expect(old.progress?.received).toBe(512);
    expect(newer.progress).toBeUndefined();
  });
  it("finishes an already cached receive without creating another request", async () => {
    const cache = fakeCache();
    cache.getReqRanges.mockResolvedValue([]);
    f.caches.set("file", cache);
    const message = {
      ...fileMessage("cached"),
      client: "peer",
      target: "local",
    };
    f.messages.messages.push(message);
    await f.service.requestFile(
      f.session,
      {
        id: "file",
        fileName: "sample.bin",
        fileSize: 2048,
        chunkSize: 1024,
      },
      true,
    );
    expect(message.transferStatus).toBe("complete");
    expect(f.transport.sendCalls).toHaveLength(0);
  });
  it("cancels a pending cache read immediately without waiting for the cache promise", async () => {
    const cache = fakeCache();
    const blocked = deferred<never>();
    cache.getInfo.mockReturnValue(blocked.promise);
    f.caches.set("file", cache);
    const outcome = f.service
      .shareFile(f.session, "file")
      .catch((error: Error) => error);
    await flushRtc();
    f.service.closeSession(f.session);
    expect(await outcome).toMatchObject({
      name: "AbortError",
    });
    expect(f.transport.sendCalls).toHaveLength(0);
  });
  it("cleans up a failed handshake instead of leaving a running transfer", async () => {
    f.caches.set("file", fakeCache());
    f.transport.sendImpl = () => {
      throw new Error("send failed");
    };
    await expect(
      f.service.shareFile(f.session, "file"),
    ).rejects.toThrow();
    expect(Object.keys(f.state)).toHaveLength(0);
    expect(f.messages.messages[0]).toMatchObject({
      status: "error",
      transferStatus: "error",
    });
  });
  it("rejects operations after disposal and unregisters its channel listeners", async () => {
    f.caches.set("file", fakeCache());
    f.service.dispose();
    await expect(
      f.service.shareFile(f.session, "file"),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(f.transport.sendCalls).toHaveLength(0);
  });
});

it("pauses an unacknowledged file request as resumable rather than failed", async () => {
  f.caches.set("file", fakeCache());
  const outcome = f.service
    .shareFile(f.session, "file")
    .catch((error: Error) => error);
  await flushRtc();
  expect(f.registry.get(f.session, "file")).toBeDefined();
  await f.service.pauseFile(f.session, "file");
  expect(await outcome).toMatchObject({
    name: "AbortError",
  });
  await flushRtc();
  expect(f.messages.messages[0]).toMatchObject({
    status: "received",
    transferStatus: "paused",
  });
  expect(f.messages.messages[0].error).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
});

it("a run timeout also interrupts a stuck setup promise", async () => {
  f.autoAck();
  f.caches.set("file", fakeCache());
  vi.spyOn(f.registry, "initialize").mockImplementation(
    () => new Promise(() => {}),
  );
  const outcome = f.service
    .shareFile(f.session, "file")
    .catch((error: Error) => error);
  await flushRtc();
  await vi.advanceTimersByTimeAsync(1001);
  expect(await outcome).toMatchObject({
    message: "file transfer channel timeout",
  });
  expect(f.messages.messages[0].transferStatus).toBe(
    "error",
  );
  expect(Object.keys(f.state)).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});
