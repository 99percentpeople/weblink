import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { File as NodeFile } from "node:buffer";
import { SharedFileTransfers } from "@/libs/application/transfer/shared-file-transfers";
import { FileTransferService } from "@/libs/application/transfer/file-transfer-service";
import { PeerMessagingService } from "@/libs/application/messaging/peer-messaging-service";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import {
  FileCatalogIndex,
  toCatalogMetadata,
} from "@/libs/application/file-catalog-index";
import { FileCatalogService } from "@/libs/application/file-catalog-service";
import { createSessionMessage } from "@/libs/domain/protocol";
import { setupLibrary } from "../support/file-library";
import {
  FakeRtcTransport,
  deferred,
  flushRtc,
} from "../support/rtc-transport";
import {
  fileSession,
  fakeChannel,
  registryFixture,
} from "../support/file-transfer";

const stops: (() => void)[] = [];
beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.unstubAllGlobals();
});
function node(id: string, peer: string) {
  const f = registryFixture(),
    lib = setupLibrary();
  const session = Object.assign(fileSession(peer), {
    clientId: id,
  });
  const transport = new FakeRtcTransport();
  const protocol = new RtcProtocol(transport);
  let connected = true,
    permission = true,
    supported = true;
  const getSession = () =>
    connected ? session : undefined;
  const caches = {
    library: lib.library,
    getCache: (id: string) => lib.caches.get(id) ?? null,
    createCache: async (id = crypto.randomUUID()) => {
      const cache = await lib.storage(id);
      await cache.setInfo({
        isComplete: false,
        file: undefined,
      });
      cache.getReqRanges.mockImplementation(async () => {
        const info = (await cache.getInfo())!;
        return info.fileSize
          ? [
              [
                0,
                Math.ceil(info.fileSize / info.chunkSize!) -
                  1,
              ],
            ]
          : [];
      });
      lib.caches.set(id, cache);
      return cache;
    },
  };
  const rtc = {
    onChannel: () => () => {},
    onSessionClosed:
      transport.onSessionClosed.bind(transport),
  };
  const files = new FileTransferService({
    protocol,
    rtc,
    registry: f.registry,
    caches,
    messages: f.messages,
    messaging: new PeerMessagingService(
      protocol,
      f.messages,
    ),
    getSession,
    getChunkSize: () => 1024,
  });
  const shared = new SharedFileTransfers({
    protocol,
    rtc,
    registry: f.registry,
    caches,
    receives: files.contentReceives,
    getSession,
    canShare: () => permission && connected,
    supports: () => supported,
    reportError: f.report,
  });
  const index = new FileCatalogIndex();
  const catalog = new FileCatalogService({
    protocol,
    index,
    getSessions: () => [session],
    isReady: () => connected,
    canList: () => permission,
    supports: () => supported,
    onSessionClosed: rtc.onSessionClosed,
  });
  stops.push(() => {
    shared.dispose();
    catalog.dispose();
    files.dispose();
    protocol.dispose();
    lib.library.dispose();
  });
  return {
    ...f,
    ...lib,
    cacheApi: caches,
    session,
    transport,
    protocol,
    files,
    shared,
    index,
    catalog,
    setPermission(value: boolean) {
      permission = value;
      shared.syncPermissions();
      catalog.syncSharing();
    },
    setSupported(value: boolean) {
      supported = value;
    },
    disconnect() {
      connected = false;
      transport.close(session);
    },
  };
}
function pair() {
  const a = node("a", "b"),
    b = node("b", "a");
  a.transport.sendImpl = (_session, message) => {
    void b.transport.emit(b.session, message);
  };
  b.transport.sendImpl = (_session, message) => {
    void a.transport.emit(a.session, message);
  };
  return { a, b };
}
async function share(
  a: ReturnType<typeof node>,
  text = "shared content",
) {
  const local = await a.library.importFile(
    new File([text], "shared.txt"),
  );
  await a.library.setShared(local.cache.id, true);
  const [info] = await a.library.sharedFiles();
  a.index.update(info.id, { ...info, isComplete: true });
  return {
    local,
    info: toCatalogMetadata(info),
    file: (await local.cache.getFile())!,
  };
}

describe("shared file authorization and independent jobs", () => {
  it.each([false, true])(
    "cancels a download (paused=%s) terminally and allows a fresh get",
    async (paused) => {
      const { a, b } = pair();
      const { info } = await share(a);
      await b.shared.download("a", info);
      const transfer = b.created[0];
      const task = b.shared.tasks()[0];
      expect(task.fileId).toBe(transfer.cache.id);
      transfer.dispatchEvent("progress", {
        received: 7,
        total: info.fileSize,
      });
      if (paused) task.pause();
      await task.cancel();
      await task.cancel();
      expect(b.raw.has(transfer.cache.id)).toBe(false);
      expect(b.caches.has(transfer.cache.id)).toBe(false);
      expect(await b.repository.references()).toHaveLength(
        0,
      );
      expect(transfer.closed).toBe(true);
      expect(transfer.channel?.close).toHaveBeenCalled();
      expect(
        b.shared.downloadTask("a", info.id),
      ).toMatchObject({
        id: task.id,
        status: "cancelled",
        bytes: 7,
        canPause: false,
        canResume: false,
      });
      transfer.dispatchEvent("progress", {
        received: info.fileSize,
        total: info.fileSize,
      });
      transfer.finish();
      await task.resume();
      await flushRtc();
      expect(b.shared.tasks()[0].status).toBe("cancelled");
      expect(b.created).toHaveLength(1);
      expect(b.report).not.toHaveBeenCalled();
      await b.shared.download("a", info);
      expect(b.created).toHaveLength(2);
      expect(
        b.shared.downloadTask("a", info.id)?.id,
      ).not.toBe(task.id);
      expect(b.shared.tasks()[0].status).toBe("cancelled");
      b.shared.clearFinished();
      expect(b.shared.tasks()).toHaveLength(1);
      expect(a.messages.messages).toEqual([]);
      expect(b.messages.messages).toEqual([]);
    },
  );
  it("cancels a pending authorization without failure or channel creation", async () => {
    const { a, b } = pair();
    const { info } = await share(a);
    b.transport.sendImpl = () => {};
    const starting = b.shared.download("a", info);
    await vi.waitFor(() =>
      expect(b.shared.tasks()).toHaveLength(1),
    );
    await b.shared.tasks()[0].cancel();
    await expect(starting).resolves.toBeUndefined();
    expect(b.shared.tasks()[0].status).toBe("cancelled");
    expect(b.session.createChannel).not.toHaveBeenCalled();
    expect(b.created).toHaveLength(0);
    expect(b.report).not.toHaveBeenCalled();
  });
  it("closes a channel that arrives after cancellation without reviving the task", async () => {
    const { a, b } = pair();
    const { info } = await share(a);
    const opening = deferred<RTCDataChannel>();
    vi.mocked(b.session.createChannel).mockReturnValueOnce(
      opening.promise,
    );
    const starting = b.shared.download("a", info);
    await vi.waitFor(() =>
      expect(
        b.session.createChannel,
      ).toHaveBeenCalledOnce(),
    );
    const cancelling = b.shared.tasks()[0].cancel();
    const channel = fakeChannel();
    opening.resolve(channel);
    await expect(starting).resolves.toBeUndefined();
    await cancelling;
    expect(b.caches.has(b.created[0].cache.id)).toBe(false);
    expect(channel.close).toHaveBeenCalledOnce();
    expect(b.shared.tasks()[0].status).toBe("cancelled");
    expect(b.report).not.toHaveBeenCalled();
  });
  it("keeps a deduplicated source for another recipient after its task is cancelled", async () => {
    const { a, b } = pair();
    const { info, file } = await share(a);
    await b.shared.download("a", info);
    const task = b.shared.tasks()[0];
    const completed = vi.fn(async (signal: AbortSignal) => {
      await b.library.reuse(
        info.fingerprint!,
        {
          ...info,
          id: "other-reference",
          libraryPinned: true,
        },
        signal,
      );
    });
    b.files.contentReceives.join(info.fingerprint!, {
      id: "other-task",
      fileId: "other-reference",
      complete: completed,
      paused: vi.fn(),
    });
    await task.cancel();
    const transfer = b.created[0];
    expect(b.caches.has(transfer.cache.id)).toBe(true);
    expect(transfer.closed).toBe(false);
    transfer.dispatchEvent("progress", {
      received: info.fileSize,
      total: info.fileSize,
    });
    expect(b.shared.tasks()[0].status).toBe("cancelled");
    // Make the verified content available, as the receive cache does before complete.
    await b.raw
      .get(transfer.cache.id)!
      .setInfo({ ...info, file, isComplete: true });
    await b.library.verifyReceived(transfer.cache);
    transfer.finish();
    await vi.waitFor(() =>
      expect(completed).toHaveBeenCalledOnce(),
    );
    await vi.waitFor(() =>
      expect(b.caches.has("other-reference")).toBe(true),
    );
    await vi.waitFor(() =>
      expect(b.caches.has(transfer.cache.id)).toBe(false),
    );
    expect(
      await b.caches.get("other-reference")?.getFile(),
    ).not.toBeNull();
    expect(b.shared.tasks()[0].status).toBe("cancelled");
    expect(b.report).not.toHaveBeenCalled();
  });
  it("can cancel a shared upload without deleting the shared file", async () => {
    const { a, b } = pair();
    const { info, local } = await share(a);
    await b.shared.download("a", info);
    await a.shared.tasks()[0].cancel();
    expect(a.created[0].closed).toBe(true);
    expect(a.shared.tasks()[0].status).toBe("cancelled");
    expect((await local.cache.getInfo())?.isShared).toBe(
      true,
    );
    expect(await local.cache.getFile()).not.toBeNull();
  });
  it("cancels final verification without a late completion or failure notification", async () => {
    const { a, b } = pair();
    const { info, file } = await share(a);
    await b.shared.download("a", info);
    const transfer = b.created[0];
    await b.raw
      .get(transfer.cache.id)!
      .setInfo({ ...info, file, isComplete: true });
    const hashing =
      deferred<NonNullable<typeof info.fingerprint>>();
    b.hash.mockReturnValueOnce(hashing.promise);
    transfer.finish();
    await vi.waitFor(() =>
      expect(b.hash).toHaveBeenCalledOnce(),
    );
    expect(b.shared.tasks()[0].status).toBe("finalizing");
    await b.shared.tasks()[0].cancel();
    expect(b.caches.has(transfer.cache.id)).toBe(false);
    expect(b.raw.has(transfer.cache.id)).toBe(false);
    hashing.resolve(info.fingerprint!);
    await flushRtc();
    expect(b.shared.tasks()[0].status).toBe("cancelled");
    expect(b.report).not.toHaveBeenCalled();
    expect(await b.repository.references()).toHaveLength(0);
  });
  it("queries only shared references and downloads into a task without creating either peer's chat messages", async () => {
    const { a, b } = pair();
    const { info, file } = await share(a);
    const page = await b.protocol.call(
      b.session,
      "request-storage",
      { pageIndex: 0, pageSize: 50 },
    );
    expect(page.items).toEqual([info]);
    await b.shared.download("a", info);
    expect(a.messages.messages).toEqual([]);
    expect(b.messages.messages).toEqual([]);
    const receiver = b.created[0];
    expect(receiver).toBeDefined();
    receiver.dispatchEvent("progress", {
      received: 7,
      total: info.fileSize,
    });
    expect(
      b.shared.downloadTask("a", info.id),
    ).toMatchObject({
      status: "running",
      bytes: 7,
      total: info.fileSize,
    });
    expect(
      b.shared.downloadTask("another-member", info.id),
    ).toBeUndefined();
    await b.raw.get(receiver.cache.id)!.setInfo({
      ...info,
      file,
      isComplete: true,
      libraryPinned: true,
    });
    receiver.finish();
    await vi.waitFor(() =>
      expect(b.shared.tasks()[0].status).toBe("completed"),
    );
    expect(b.shared.downloadTask("a", info.id)?.bytes).toBe(
      info.fileSize,
    );
    expect(b.shared.tasks()[0]).not.toHaveProperty(
      "message",
    );
    const received = (await b.caches
      .get(receiver.cache.id)
      ?.getInfo())!;
    expect(received.isComplete).toBe(true);
    expect(received.isShared).toBe(false);
    expect(await b.library.sharedFiles()).toEqual([]);
    const refs = await b.repository.references();
    await b.shared.download("a", info);
    expect(b.shared.tasks()).toHaveLength(1);
    expect(b.created).toHaveLength(1);
    expect(await b.repository.references()).toEqual(refs);
    b.shared.clearFinished();
    await b.shared.download("a", info);
    expect(b.shared.tasks()).toHaveLength(0);
    expect(await b.repository.references()).toEqual(refs);
    await b.library.removeFile(receiver.cache.id);
    await b.shared.download("a", info);
    expect(b.created).toHaveLength(2);
    expect(b.shared.tasks()).toHaveLength(1);

    expect(a.messages.messages).toEqual([]);
    expect(b.messages.messages).toEqual([]);
  });
  it("skips locally verified content without creating tasks, references or requests, including aliases from another member", async () => {
    const { a, b } = pair();
    const { info, file } = await share(a);
    await b.library.importFile(file);
    const refs = await b.repository.references();
    const requests = b.transport.sendCalls.length;
    await b.shared.download("a", info);
    await b.shared.download("another-member", {
      ...info,
      id: "another-id",
      fileName: "renamed.txt",
    });
    expect(b.shared.tasks()).toEqual([]);
    expect(await b.repository.references()).toEqual(refs);
    expect(b.transport.sendCalls).toHaveLength(requests);
    expect(b.created).toHaveLength(0);
    expect(a.created).toHaveLength(0);
  });
  it("deduplicates concurrent gets by fingerprint", async () => {
    const { a, b } = pair();
    const { info } = await share(a);
    await Promise.all([
      b.shared.download("a", info),
      b.shared.download("a", info),
      b.shared.download("another-member", {
        ...info,
        id: "alias",
      }),
    ]);
    expect(b.shared.tasks()).toHaveLength(1);
    expect(b.created).toHaveLength(1);
    expect(
      b.shared.downloadTask(
        "another-member",
        "alias",
        info.fingerprint,
      )?.id,
    ).toBe(b.shared.tasks()[0].id);
  });
  it("cleans a cache that finishes being created after cancellation", async () => {
    const { a, b } = pair();
    const { info } = await share(a);
    const creating = deferred<void>();
    const createCache = b.cacheApi.createCache;
    const create = vi
      .spyOn(b.cacheApi, "createCache")
      .mockImplementation(async (id) => {
        await creating.promise;
        return createCache(id);
      });
    const starting = b.shared.download("a", info);
    await vi.waitFor(() =>
      expect(create).toHaveBeenCalledOnce(),
    );
    const cancelling = b.shared.tasks()[0].cancel();
    creating.resolve();
    await Promise.all([starting, cancelling]);
    const id = create.mock.calls[0][0]!;
    expect(b.raw.has(id)).toBe(false);
    expect(b.caches.has(id)).toBe(false);
    expect(b.session.createChannel).not.toHaveBeenCalled();
  });
  it.each(["cancel", "fail"])(
    "cleans a cancelled source when its final recipient leaves via %s",
    async (ending) => {
      const { a, b } = pair();
      const { info } = await share(a);
      await b.shared.download("a", info);
      const task = b.shared.tasks()[0];
      const sourceId = b.created[0].cache.id;
      b.files.contentReceives.join(info.fingerprint!, {
        id: "other",
        fileId: "other",
        complete: async () => {},
        paused: () => {},
      });
      await task.cancel();
      expect(b.caches.has(sourceId)).toBe(true);
      if (ending === "cancel")
        b.files.contentReceives.cancel("other");
      else
        b.created[0].dispatchEvent(
          "error",
          new Error("Disconnected"),
        );
      await vi.waitFor(() =>
        expect(b.caches.has(sourceId)).toBe(false),
      );
      expect(b.raw.has(sourceId)).toBe(false);
    },
  );
  it("revokes directory transfers on unshare and permission changes, without deleting local bytes", async () => {
    const { a, b } = pair();
    const { info, local } = await share(a);
    await b.shared.download("a", info);
    const sender = a.created[0];
    await a.library.setShared(local.cache.id, false);
    expect(sender.closed).toBe(true);
    expect(await local.cache.getFile()).not.toBeNull();
    await expect(
      b.protocol.call(b.session, "request-shared-file", {
        fid: info.id,
        transferId: "shared-transfer_probe",
        fingerprint: info.fingerprint!,
        chunkSize: info.chunkSize!,
        have: true,
      }),
    ).rejects.toThrow(/no longer shared/);
    await a.library.setShared(local.cache.id, true);
    b.shared.tasks()[0].pause();
    await b.shared.tasks()[0].resume();
    a.setPermission(false);
    expect(a.created.at(-1)?.closed).toBe(true);
    expect(a.messages.messages).toHaveLength(0);
  });
  it("rejects forged directory IDs, fingerprints, deleted files and unsupported peers", async () => {
    const { a, b } = pair();
    const { info, local } = await share(a);
    await expect(
      b.shared.download("a", {
        ...info,
        id: local.cache.id,
      }),
    ).rejects.toThrow(/no longer shared/);
    await expect(
      b.shared.download("a", { ...info, id: "forged" }),
    ).rejects.toThrow(/no longer shared/);
    await expect(
      b.shared.download("a", {
        ...info,
        fingerprint: {
          ...info.fingerprint!,
          digest: "f".repeat(64),
        },
        id: "forged-fp",
      }),
    ).rejects.toThrow();
    await a.library.removeFile(local.cache.id);
    await expect(
      b.shared.download("a", info),
    ).rejects.toThrow(/no longer shared/);
    b.setSupported(false);
    await expect(
      b.shared.download("a", {
        ...info,
        id: "unsupported",
      }),
    ).rejects.toThrow(/does not support/);
    expect(a.created).toHaveLength(0);
    expect(b.created).toHaveLength(0);
  });
  it("legacy requests cannot obtain arbitrary caches or shared references; explicit chat grants survive unsharing", async () => {
    const { a, b } = pair();
    const { info, local } = await share(a);
    const payload = {
      fileName: info.fileName,
      fileSize: info.fileSize,
      chunkSize: info.chunkSize!,
      lastModified: info.lastModified,
      mimeType: info.mimetype,
      resume: true,
    };
    for (const fid of [info.id, local.cache.id])
      await expect(
        b.protocol.call(b.session, "request-file", {
          ...payload,
          fid,
        }),
      ).rejects.toThrow(/not sent/);
    a.messages.messages.push({
      ...payload,
      type: "file",
      fid: local.cache.id,
      id: "explicit-offer",
      client: "a",
      target: "b",
      status: "received",
      createdAt: 1,
    });
    await a.library.setShared(local.cache.id, false);
    await expect(
      b.protocol.call(
        b.session,
        "request-file",
        { ...payload, fid: local.cache.id },
        { id: "explicit-offer" },
      ),
    ).resolves.toMatchObject({ type: "ack" });
    expect(a.created).toHaveLength(1);
  });
  it("auto-shares new private and library sends, preserves unshare on retries, and re-enables it on a new send", async () => {
    const { a, b } = pair();
    const local = await a.library.importFile(
      new File(["send content"], "send.txt"),
    );
    const source = {
      kind: "library" as const,
      localFileId: local.cache.id,
    };
    await a.files.sendFile(a.session, source);
    expect((await local.cache.getInfo())?.isShared).toBe(
      true,
    );
    a.registry.clear();
    b.registry.clear();
    const message = a.messages.messages[0];
    await a.library.setShared(local.cache.id, false);
    await a.files.retryFile(a.session, message);
    expect((await local.cache.getInfo())?.isShared).toBe(
      false,
    );
    a.registry.clear();
    b.registry.clear();
    await a.files.shareFile(a.session, local.cache.id);
    expect((await local.cache.getInfo())?.isShared).toBe(
      true,
    );
    expect(await a.library.sharedFiles()).toHaveLength(1);
  });
  it("does not share on offline validation or failed preparation, but retains sharing after send failure", async () => {
    const { a } = pair();
    const local = await a.library.importFile(
      new File(["private"], "private.txt"),
    );
    const source = {
      kind: "library" as const,
      localFileId: local.cache.id,
    };
    Object.defineProperty(
      a.session,
      "isMessageChannelReady",
      { value: false, configurable: true },
    );
    await expect(
      a.files.sendFile(a.session, source),
    ).rejects.toThrow(/not connected/);
    expect((await local.cache.getInfo())?.isShared).toBe(
      false,
    );
    Object.defineProperty(
      a.session,
      "isMessageChannelReady",
      { value: true, configurable: true },
    );
    a.hash.mockRejectedValueOnce(
      new Error("Import failed"),
    );
    await expect(
      a.files.sendFile(
        a.session,
        new File(["failure"], "bad.txt"),
      ),
    ).rejects.toThrow(/Import failed/);
    expect(await a.library.sharedFiles()).toHaveLength(0);
    a.transport.sendImpl = () => {
      throw new Error("Network failed");
    };
    await expect(
      a.files.sendFile(a.session, source),
    ).rejects.toThrow(/Network failed/);
    expect((await local.cache.getInfo())?.isShared).toBe(
      true,
    );
  });
  it("rechecks connectivity after file preparation before creating the message or enabling sharing", async () => {
    const { a } = pair();
    const hash = a.hash.getMockImplementation()!;
    a.hash.mockImplementationOnce(async (file) => {
      const fingerprint = await hash(file);
      Object.defineProperty(
        a.session,
        "isMessageChannelReady",
        { value: false },
      );
      return fingerprint;
    });
    await expect(
      a.files.sendFile(
        a.session,
        new File(["offline during hash"], "offline.txt"),
      ),
    ).rejects.toThrow(/not connected/);
    expect(a.messages.messages).toHaveLength(0);
    expect(await a.library.sharedFiles()).toHaveLength(0);
  });
});
