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
import type {
  ChunkCache,
  ChunkMetaData,
} from "@/libs/domain/file";
import type { FileTransferMessage } from "@/libs/domain/message";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "../support/rtc-transport";
import {
  fakeCache,
  fakeChannel,
  fileMessage,
  fileSession,
  registryFixture,
} from "../support/file-transfer";

function setup() {
  const fixture = registryFixture();
  const transport = new FakeRtcTransport();
  const protocol = new RtcProtocol(transport);
  const sessions = new Map<string, PeerSession>();
  const caches = new Map<string, ChunkCache>();
  const channels = new Set<RtcChannelHandler>();
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
  const service = new FileTransferService({
    protocol,
    registry: fixture.registry,
    caches: cacheApi,
    messages: fixture.messages,
    messaging: new PeerMessagingService(
      protocol,
      fixture.messages,
    ),
    rtc: {
      onSessionClosed:
        transport.onSessionClosed.bind(transport),
      onChannel: (handler) => {
        channels.add(handler);
        return () => {
          channels.delete(handler);
        };
      },
    },
    getSession: (id) => sessions.get(id),
    getChunkSize: () => 1024,
  });
  const peer = (id = "peer") => {
    const session = fileSession(id);
    sessions.set(id, session);
    return session;
  };
  const emitChannel = async (
    session: PeerSession,
    channel = fakeChannel(),
  ) => {
    for (const handler of channels)
      await handler({ session, channel });
    return channel;
  };
  return {
    ...fixture,
    service,
    caches,
    cacheApi,
    peer,
    transport,
    emitChannel,
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
function offer(receiving = false): FileTransferMessage {
  const message: FileTransferMessage = {
    ...fileMessage("offer"),
    client: receiving ? "peer" : "local",
    target: receiving ? "local" : "room:demo",
    conversationId: "room:demo",
    room: {
      roomId: "demo",
      senderName: "Sender",
      senderAvatar: null,
    },
    status: "received",
    transferStatus: undefined,
    deliveries: { peer: "delivered", other: "failed" },
  };
  f.messages.messages.push(message);
  return message;
}
function info(message: FileTransferMessage): ChunkMetaData {
  return {
    id: message.fid!,
    fileName: message.fileName,
    fileSize: message.fileSize,
    chunkSize: message.chunkSize,
    lastModified: message.lastModified,
    mimetype: message.mimeType,
    roomAttachment: true,
    roomOfferId: message.id,
    from: message.client,
  };
}
async function cached(message: FileTransferMessage) {
  const cache = fakeCache(message.fid);
  await cache.setInfo(info(message));
  f.caches.set(cache.id, cache);
  return cache;
}

describe("room attachment transfer lifecycle", () => {
  it("persists arbitrary binary bytes and room scope without offering through a private message or opening a channel", async () => {
    const source = new File(
      [new Uint8Array([0, 255, 1, 0, 239])],
      "opaque.bin",
      {
        type: "application/octet-stream",
        lastModified: 17,
      },
    );
    const metadata = await f.service.prepareRoomFile(
      source,
      { messageId: "offer", clientId: "local" },
    );
    expect(metadata).toMatchObject({
      fileName: "opaque.bin",
      fileSize: 5,
      chunkSize: 1024,
      roomAttachment: true,
      roomOfferId: "offer",
      from: "local",
    });
    expect(metadata.file).toBeUndefined();
    expect(
      (await f.caches.get(metadata.id)!.getInfo())?.file,
    ).toBe(source);
    expect(f.messages.messages).toHaveLength(0);
    expect(f.transport.sendCalls).toHaveLength(0);
    expect(f.created).toHaveLength(0);
  });

  it("serves one offer to two peers with independent progress and retains it for a later recipient despite automatic deletion", async () => {
    f.setAutoDelete(true);
    const message = offer();
    const cache = await cached(message);
    const a = f.peer("peer"),
      b = f.peer("other");
    const epoch = new AbortController();
    await Promise.all(
      [a, b].map((session) =>
        f.service.serveFileOffer(session, {
          fid: cache.id,
          messageId: message.id,
          resume: false,
          signal: epoch.signal,
          info: info(message),
        }),
      ),
    );
    await Promise.all([f.emitChannel(a), f.emitChannel(b)]);
    f.created[0].dispatchEvent("progress", {
      total: 2048,
      received: 256,
    });
    f.created[1].dispatchEvent("progress", {
      total: 2048,
      received: 1024,
    });
    expect(
      message.roomTransfers?.peer.progress?.received,
    ).toBe(256);
    expect(
      message.roomTransfers?.other.progress?.received,
    ).toBe(1024);
    expect(message.progress).toBeUndefined();
    expect(message.transferStatus).toBeUndefined();
    expect(message.deliveries).toEqual({
      peer: "delivered",
      other: "failed",
    });
    f.created[0].finish();
    await flushRtc();
    expect(cache.cleanup).not.toHaveBeenCalled();
    f.created[1].finish();
    await flushRtc();
    expect(cache.cleanup).not.toHaveBeenCalled();
    expect(message.roomTransfers?.peer.status).toBe(
      "complete",
    );
    expect(message.roomTransfers?.other.status).toBe(
      "complete",
    );
    const c = f.peer("later");
    await f.service.serveFileOffer(c, {
      fid: cache.id,
      messageId: message.id,
      resume: false,
      signal: epoch.signal,
    });
    expect(f.registry.get(c, cache.id)).toBeDefined();
    expect(f.messages.messages).toHaveLength(1);
    expect(
      f.messages.setSendMessage,
    ).not.toHaveBeenCalled();
    expect(
      f.messages.setReceiveMessage,
    ).not.toHaveBeenCalled();
    expect(f.transport.sendCalls).toHaveLength(0);
  });

  it("binds an explicit room download to its existing message and resumes only missing chunks after pause", async () => {
    const message = offer(true);
    const session = f.peer();
    const epoch = new AbortController();
    const request = vi.fn(async () => {});
    await f.service.receiveFileOffer(
      session,
      info(message),
      {
        messageId: message.id,
        signal: epoch.signal,
        request,
      },
    );
    expect(request).toHaveBeenCalledWith(
      [[0, 1]],
      expect.any(AbortSignal),
    );
    f.created[0].dispatchEvent("progress", {
      total: 2048,
      received: 1024,
    });
    expect(message.progress?.received).toBe(1024);
    expect(message.roomTransfers).toBeUndefined();
    expect(message.deliveries).toEqual({
      peer: "delivered",
      other: "failed",
    });
    expect(f.messages.messages).toHaveLength(1);
    await f.service.pauseFile(session, message.fid!);
    expect(message.transferStatus).toBe("paused");
    const cache = f.caches.get(message.fid!) as ReturnType<
      typeof fakeCache
    >;
    cache.getReqRanges.mockResolvedValue([1]);
    await f.service.receiveFileOffer(
      session,
      info(message),
      {
        messageId: message.id,
        signal: epoch.signal,
        request,
      },
    );
    expect(request).toHaveBeenLastCalledWith(
      [1],
      expect.any(AbortSignal),
    );
    f.created[1].finish();
    await flushRtc();
    expect(message.transferStatus).toBe("complete");
    expect(message.status).toBe("received");
    expect(
      f.messages.setSendMessage,
    ).not.toHaveBeenCalled();
    expect(
      f.messages.setReceiveMessage,
    ).not.toHaveBeenCalled();
  });

  it("finishes an already-cached attachment without a channel or network request", async () => {
    const message = offer(true);
    const cache = await cached(message);
    cache.getReqRanges.mockResolvedValue([]);
    const request = vi.fn(async () => {});
    await f.service.receiveFileOffer(
      f.peer(),
      info(message),
      {
        messageId: message.id,
        signal: new AbortController().signal,
        request,
      },
    );
    expect(message.transferStatus).toBe("complete");
    expect(request).not.toHaveBeenCalled();
    expect(f.created).toHaveLength(0);
    expect(f.messages.messages).toHaveLength(1);
  });

  it("keeps an offer and its receipt when the transfer handshake fails, then retries the same attachment", async () => {
    const message = offer(true);
    const session = f.peer();
    const epoch = new AbortController();
    await expect(
      f.service.receiveFileOffer(session, info(message), {
        messageId: message.id,
        signal: epoch.signal,
        request: async () => {
          throw new Error("Sender left");
        },
      }),
    ).rejects.toThrow("Sender left");
    expect(message.transferStatus).toBe("error");
    expect(message.status).toBe("received");
    expect(message.deliveries?.peer).toBe("delivered");
    expect(
      f.registry.get(session, message.fid!),
    ).toBeUndefined();
    await f.service.receiveFileOffer(
      session,
      info(message),
      {
        messageId: message.id,
        signal: epoch.signal,
        request: async () => {},
      },
    );
    expect(message.transferStatus).toBe("transfering");
    expect(message.error).toBeUndefined();
    expect(f.messages.messages).toHaveLength(1);
  });

  it("keeps the room epoch attached after setup returns and pauses both receiving and sending runs on leave", async () => {
    const receiving = offer(true);
    const session = f.peer();
    const epoch = new AbortController();
    await f.service.receiveFileOffer(
      session,
      info(receiving),
      {
        messageId: receiving.id,
        signal: epoch.signal,
        request: async () => {},
      },
    );
    const channel = f.created[0].channel!;
    epoch.abort();
    expect(
      f.registry.get(session, receiving.fid!),
    ).toBeUndefined();
    expect(receiving.transferStatus).toBe("paused");
    expect(channel.close).toHaveBeenCalled();
    f.messages.messages.length = 0;
    f.caches.clear();
    const sending = offer();
    const cache = await cached(sending);
    const senderEpoch = new AbortController();
    await f.service.serveFileOffer(session, {
      fid: cache.id,
      messageId: sending.id,
      resume: false,
      signal: senderEpoch.signal,
    });
    senderEpoch.abort();
    expect(sending.roomTransfers?.peer.status).toBe(
      "paused",
    );
    expect(sending.transferStatus).toBeUndefined();
    expect(
      f.registry.get(session, cache.id),
    ).toBeUndefined();
  });

  it("cancels a stuck request on leave and closes a late-created channel", async () => {
    const message = offer(true);
    const session = f.peer();
    const epoch = new AbortController();
    const late = deferred<RTCDataChannel>();
    session.createChannel = vi.fn(() => late.promise);
    const outcome = f.service
      .receiveFileOffer(session, info(message), {
        messageId: message.id,
        signal: epoch.signal,
        request: async () => {},
      })
      .catch((error: Error) => error);
    await flushRtc();
    expect(session.createChannel).toHaveBeenCalled();
    epoch.abort();
    expect(await outcome).toMatchObject({
      name: "AbortError",
    });
    const channel = fakeChannel();
    late.resolve(channel);
    await flushRtc();
    expect(channel.close).toHaveBeenCalled();
    expect(message.transferStatus).toBe("paused");
  });

  it.each([
    { roomAttachment: undefined },
    { roomOfferId: "another-offer" },
    { from: "another-peer" },
    { fileSize: 123 },
    { fileName: "another.bin" },
    { chunkSize: 17 },
    { mimetype: "text/plain" },
    { lastModified: 99 },
  ])(
    "rejects cache collisions with mismatched scope or immutable metadata: %j",
    async (changed) => {
      const message = offer(true);
      const cache = await cached(message);
      await cache.setInfo(changed);
      const request = vi.fn(async () => {});
      await expect(
        f.service.receiveFileOffer(
          f.peer(),
          info(message),
          {
            messageId: message.id,
            signal: new AbortController().signal,
            request,
          },
        ),
      ).rejects.toThrow(/metadata/);
      expect(request).not.toHaveBeenCalled();
      expect(f.created).toHaveLength(0);
      expect(f.messages.messages).toHaveLength(1);
    },
  );

  it("rejects legacy requests and reverse resumes for a room-only cache without creating private messages", async () => {
    const message = offer();
    await cached(message);
    const session = f.peer();
    const base = {
      clientId: "peer",
      targetClientId: "local",
    };
    await f.transport.emit(
      session,
      createSessionMessage(
        base,
        "request-file",
        {
          fid: message.fid!,
          fileName: message.fileName,
          fileSize: message.fileSize,
          chunkSize: message.chunkSize,
          resume: false,
        },
        { id: "legacy-request" },
      ),
    );
    await f.transport.emit(
      session,
      createSessionMessage(
        base,
        "resume-file",
        { fid: message.fid! },
        { id: "legacy-resume" },
      ),
    );
    await f.transport.emit(
      session,
      createSessionMessage(
        base,
        "send-file",
        {
          fid: message.fid!,
          fileName: "replacement.bin",
          fileSize: 10,
          chunkSize: message.chunkSize,
        },
        { id: "legacy-overwrite" },
      ),
    );
    expect(
      f.transport.sendCalls.map(
        ({ message }) => message.type,
      ),
    ).toEqual(["error", "error", "error"]);
    expect(
      await f.caches.get(message.fid!)!.getInfo(),
    ).toMatchObject(info(message));
    await expect(
      f.service.requestFile(
        session,
        { ...info(message), roomAttachment: undefined },
        true,
      ),
    ).rejects.toThrow(/authorized room/);
    expect(f.messages.messages).toHaveLength(1);
    expect(
      f.messages.setReceiveMessage,
    ).not.toHaveBeenCalled();
    expect(
      f.messages.setSendMessage,
    ).not.toHaveBeenCalled();
    expect(f.created).toHaveLength(0);
  });

  it("forwards a local room attachment as a new private copy without changing the original cache or offer", async () => {
    const message = offer();
    const cache = await cached(message);
    const original = { ...(await cache.getInfo()) };
    const session = f.peer();
    f.transport.sendImpl = async (_, sent) => {
      if (sent.type !== "send-file") return;
      await f.transport.emit(
        session,
        createSessionMessage(
          { clientId: "peer", targetClientId: "local" },
          "ack",
          { mode: "receive" },
          { id: sent.id },
        ),
      );
    };
    await f.service.shareFile(session, message.fid!);
    const sent = f.transport.sendCalls.find(
      ({ message }) => message.type === "send-file",
    )?.message;
    expect(sent?.type).toBe("send-file");
    if (sent?.type !== "send-file")
      throw new Error("private share missing");
    expect(sent.fid).not.toBe(message.fid);
    const copy = await f.caches.get(sent.fid)!.getInfo();
    expect(copy).toMatchObject({
      file: original.file,
      fileName: original.fileName,
      fileSize: original.fileSize,
    });
    expect(copy?.roomAttachment).toBeUndefined();
    expect(copy?.roomOfferId).toBeUndefined();
    expect(await cache.getInfo()).toEqual(original);
    expect(cache.cleanup).not.toHaveBeenCalled();
    expect(message.roomTransfers).toBeUndefined();
    expect(message.deliveries).toEqual({
      peer: "delivered",
      other: "failed",
    });
    expect(f.messages.messages).toHaveLength(2);
    expect(
      f.messages.messages.find(
        (stored) => stored.id === sent.id,
      ),
    ).toMatchObject({ target: "peer", fid: sent.fid });
    expect(
      f.messages.messages.find(
        (stored) => stored.id === sent.id,
      )?.room,
    ).toBeUndefined();
    expect(
      f.registry.get(session, message.fid!),
    ).toBeUndefined();
    expect(f.registry.get(session, sent.fid)).toBeDefined();
  });

  it("does not publish a private copy after cancellation while reading a room cache", async () => {
    const message = offer();
    const cache = await cached(message);
    const reading = deferred<File | null>();
    cache.getFile.mockReturnValueOnce(reading.promise);
    const session = f.peer();
    const pending = f.service.shareFile(
      session,
      message.fid!,
    );
    const cancelled =
      expect(pending).rejects.toThrow(/cancelled/i);
    await flushRtc();
    expect(cache.getFile).toHaveBeenCalled();
    f.service.closeSession(session);
    await cancelled;
    reading.resolve(new File(["late"], "late.bin"));
    await flushRtc();
    expect(f.caches.size).toBe(1);
    expect(f.transport.sendCalls).toHaveLength(0);
    expect(f.messages.messages).toHaveLength(1);
    expect(cache.cleanup).not.toHaveBeenCalled();
  });

  it("propagates cancellation of a local room forward to its private copy while waiting for acknowledgement", async () => {
    const message = offer();
    const cache = await cached(message);
    const session = f.peer();
    const pending = f.service.shareFile(
      session,
      message.fid!,
    );
    const cancelled =
      expect(pending).rejects.toThrow(/cancelled/i);
    await flushRtc();
    const sent = f.transport.sendCalls.find(
      ({ message }) => message.type === "send-file",
    )?.message;
    if (sent?.type !== "send-file")
      throw new Error("private share missing");
    expect(f.registry.get(session, sent.fid)).toBeDefined();
    await f.service.pauseFile(session, message.fid!);
    await cancelled;
    await flushRtc();
    expect(
      f.registry.get(session, sent.fid),
    ).toBeUndefined();
    await f.transport.emit(
      session,
      createSessionMessage(
        { clientId: "peer", targetClientId: "local" },
        "ack",
        { mode: "receive" },
        { id: sent.id },
      ),
    );
    expect(session.createChannel).not.toHaveBeenCalled();
    expect(await cache.getInfo()).toMatchObject(
      info(message),
    );
    expect(cache.cleanup).not.toHaveBeenCalled();
  });

  it("aborts only the selected recipient and does not recreate a deleted offer from late progress", async () => {
    const message = offer();
    const cache = await cached(message);
    const a = f.peer(),
      b = f.peer("other");
    const epoch = new AbortController();
    await Promise.all(
      [a, b].map((session) =>
        f.service.serveFileOffer(session, {
          fid: cache.id,
          messageId: message.id,
          resume: false,
          signal: epoch.signal,
        }),
      ),
    );
    await f.service.pauseFile(a, cache.id);
    expect(f.registry.get(a, cache.id)).toBeUndefined();
    expect(f.registry.get(b, cache.id)).toBeDefined();
    expect(message.roomTransfers?.peer.status).toBe(
      "paused",
    );
    f.messages.messages.splice(0, 1);
    f.created[1].dispatchEvent("progress", {
      total: 2048,
      received: 100,
    });
    expect(f.messages.messages).toHaveLength(0);
    await cache.cleanup();
    expect(f.registry.get(b, cache.id)).toBeUndefined();
  });
});
