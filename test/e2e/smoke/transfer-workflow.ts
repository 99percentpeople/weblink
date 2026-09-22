import type {
  ChunkCache,
  FileMetaData,
} from "../../../src/libs/domain/file";
import { IDBChunkCache } from "../../../src/libs/infrastructure/storage/indexeddb-chunk-cache";
import { FileSender } from "../../../src/libs/domain/transfer/file-sender";
import { FileReceiver } from "../../../src/libs/domain/transfer/file-receiver";
import { TransferMode } from "../../../src/libs/domain/transfer/file-transferer";
import type { PeerSession } from "../../../src/libs/domain/session";
import type { FileTransferMessage } from "../../../src/libs/domain/message";
import type { SessionMessage } from "../../../src/libs/domain/protocol/messages";
import type {
  RtcAnyMessageHandler,
  RtcSessionClosedHandler,
} from "../../../src/libs/domain/protocol/transport";
import type { RtcChannelHandler } from "../../../src/libs/application/rtc/rtc-service";
import { RtcProtocol } from "../../../src/libs/application/rtc/rtc-protocol";
import { PeerMessagingService } from "../../../src/libs/application/messaging/peer-messaging-service";
import { FileTransferService } from "../../../src/libs/application/transfer/file-transfer-service";
import { TransferRegistry } from "../../../src/libs/application/transfer/transfer-registry";
import {
  bindTransferMessage,
  finishReceivedFile,
} from "../../../src/libs/application/transfer/transfer-message-binding";
import type { FileTransferStates } from "../../../src/libs/application/transfer/file-transfer-state";

const assert: (
  value: unknown,
  message: string,
) => asserts value = (value, message) => {
  if (!value) throw new Error(message);
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(
  check: () => boolean,
  message: string,
  timeoutMs = 20000,
) {
  const start = performance.now();
  while (!check()) {
    if (performance.now() - start >= timeoutMs)
      throw new Error(message);
    await sleep(10);
  }
}

class BrowserTransport {
  readonly channels = new Map<
    PeerSession,
    RTCDataChannel
  >();
  readonly incoming = new Set<
    RtcAnyMessageHandler<PeerSession>
  >();
  readonly closed = new Set<
    RtcSessionClosedHandler<PeerSession>
  >();
  readonly files = new Set<RtcChannelHandler>();
  async send(
    session: PeerSession,
    message: SessionMessage,
  ) {
    const channel = this.channels.get(session);
    assert(
      channel?.readyState === "open",
      "control channel not open",
    );
    channel.send(JSON.stringify(message));
  }
  onAny(handler: RtcAnyMessageHandler<PeerSession>) {
    this.incoming.add(handler);
    return () => {
      this.incoming.delete(handler);
    };
  }
  onSessionClosed(
    handler: RtcSessionClosedHandler<PeerSession>,
  ) {
    this.closed.add(handler);
    return () => {
      this.closed.delete(handler);
    };
  }
  onChannel(handler: RtcChannelHandler) {
    this.files.add(handler);
    return () => {
      this.files.delete(handler);
    };
  }
  attach(session: PeerSession, channel: RTCDataChannel) {
    if (channel.protocol === "message") {
      this.channels.set(session, channel);
      channel.addEventListener("message", ({ data }) => {
        for (const handler of this.incoming)
          void Promise.resolve(
            handler({ session, message: JSON.parse(data) }),
          ).catch((error) => {
            window.__SPEED_TEST_ERROR__ = String(error);
          });
      });
    } else {
      for (const handler of this.files)
        void handler({ session, channel });
    }
  }
}

function makeNode(id: string) {
  const transport = new BrowserTransport();
  const protocol = new RtcProtocol(transport);
  const sessions = new Map<string, PeerSession>();
  const caches = new Map<string, ChunkCache>();
  const messages: FileTransferMessage[] = [];
  const active: FileTransferStates = {};
  const errors: string[] = [];
  let progressCallback:
    | ((message: FileTransferMessage) => void)
    | undefined;
  const update = (
    messageId: string,
    apply: (message: FileTransferMessage) => void,
  ) => {
    const message = messages.find(
      (item) => item.id === messageId,
    );
    if (message) {
      apply(message);
      progressCallback?.(message);
    }
  };
  const insert = (message: SessionMessage) => {
    if (
      message.type !== "send-file" &&
      message.type !== "request-file"
    )
      return;
    if (messages.some((item) => item.id === message.id))
      return;
    messages.push({
      ...message,
      type: "file",
      status: "sending",
      transferStatus: "init",
      ...(message.type === "request-file"
        ? { client: message.target, target: message.client }
        : {}),
    });
  };
  const store = {
    messages,
    setSendMessage: insert,
    retrySendMessage: (message: SessionMessage) => {
      insert(message);
      update(message.id, (item) => {
        item.status = "sending";
        item.error = undefined;
      });
    },
    setReceiveMessage: (message: SessionMessage) => {
      if (message.type === "ack")
        update(message.id, (item) => {
          item.status = "received";
        });
      else if (message.type === "error")
        update(message.id, (item) => {
          item.status = "error";
          item.error = message.error;
        });
      else insert(message);
    },
    updateTransferMessage: update,
  };
  const cacheApi = {
    getCache: (fid: string) => caches.get(fid) ?? null,
    createCache: async (fid = crypto.randomUUID()) => {
      const existing = caches.get(fid);
      if (existing) return existing;
      // Nodes share this test origin. Isolate physical IndexedDB names, while the
      // actual sender/receiver still see the same logical wire file ID.
      const raw = new IDBChunkCache({
        id: `${id}-${fid}`,
        maxMomeryCacheSize: 4,
      });
      await raw.initialize();
      const scoped: ChunkCache = new Proxy(raw, {
        get(target, key) {
          if (key === "id") return fid;
          if (key === "getInfo")
            return async (): Promise<FileMetaData | null> => {
              const info = await target.getInfo();
              return info ? { ...info, id: fid } : null;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function"
            ? value.bind(target)
            : value;
        },
      });
      caches.set(fid, scoped);
      return scoped;
    },
  };
  const registry = new TransferRegistry({
    createTransfer: ({ cache, mode, info }) =>
      mode === TransferMode.Send
        ? new FileSender({
            cache,
            info,
            blockSize: 16 * 1024,
            compressionLevel: 6,
          })
        : new FileReceiver({ cache, info }),
    publish: (runId, entry) => {
      if (entry) active[runId] = entry;
      else delete active[runId];
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
    failed: (run, error) => {
      errors.push(error.message);
      update(run.messageId, (message) => {
        message.transferStatus = "error";
        message.error = error.message;
      });
    },
    automaticCacheDeletion: () => false,
    reportError: (error) => errors.push(String(error)),
  });
  const service = new FileTransferService({
    protocol,
    rtc: transport,
    registry,
    messages: store,
    caches: cacheApi,
    messaging: new PeerMessagingService(protocol, store),
    getSession: (peer) => sessions.get(peer),
    getChunkSize: () => 64 * 1024,
  });
  return {
    id,
    transport,
    protocol,
    sessions,
    caches,
    messages,
    active,
    registry,
    service,
    cacheApi,
    errors,
    onProgress: (
      handler?: (message: FileTransferMessage) => void,
    ) => {
      progressCallback = handler;
    },
    async close() {
      service.dispose();
      protocol.dispose();
      await Promise.all(
        [...caches.values()].map((cache) =>
          cache.cleanup(),
        ),
      );
    },
  };
}
type Node = ReturnType<typeof makeNode>;

async function connect(a: Node, b: Node) {
  const pcA = new RTCPeerConnection({ iceServers: [] });
  const pcB = new RTCPeerConnection({ iceServers: [] });
  const session = (
    local: Node,
    remote: Node,
    pc: RTCPeerConnection,
  ): PeerSession =>
    ({
      clientId: local.id,
      targetClientId: remote.id,
      peerConnection: pc,
      createChannel: async (
        label: string,
        protocol: string,
      ) => {
        const channel = pc.createDataChannel(label, {
          protocol,
          ordered: true,
        });
        await until(
          () => channel.readyState === "open",
          "file channel open timeout",
        );
        return channel;
      },
    }) as PeerSession;
  const aSession = session(a, b, pcA),
    bSession = session(b, a, pcB);
  a.sessions.set(b.id, aSession);
  b.sessions.set(a.id, bSession);
  pcA.ondatachannel = ({ channel }) =>
    a.transport.attach(aSession, channel);
  pcB.ondatachannel = ({ channel }) =>
    b.transport.attach(bSession, channel);
  const control = pcA.createDataChannel("message", {
    protocol: "message",
    ordered: true,
  });
  a.transport.attach(aSession, control);
  await pcA.setLocalDescription(await pcA.createOffer());
  await until(
    () => pcA.iceGatheringState === "complete",
    "offer ICE timeout",
  );
  await pcB.setRemoteDescription(pcA.localDescription!);
  await pcB.setLocalDescription(await pcB.createAnswer());
  await until(
    () => pcB.iceGatheringState === "complete",
    "answer ICE timeout",
  );
  await pcA.setRemoteDescription(pcB.localDescription!);
  await until(
    () =>
      control.readyState === "open" &&
      b.transport.channels.get(bSession)?.readyState ===
        "open",
    "control connection timeout",
  );
  return {
    aSession,
    bSession,
    close: () => {
      pcA.close();
      pcB.close();
    },
  };
}

async function hash(file: File) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  return [...new Uint8Array(digest)]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
}
function payload(size: number) {
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += 65536)
    crypto.getRandomValues(
      bytes.subarray(
        offset,
        Math.min(size, offset + 65536),
      ),
    );
  return new File([bytes], "roundtrip.bin", {
    type: "application/octet-stream",
  });
}
async function main() {
  const a = makeNode("sender"),
    b = makeNode("receiver-b"),
    c = makeNode("receiver-c");
  const connections: Awaited<ReturnType<typeof connect>>[] =
    [];
  let report: unknown;
  try {
    const ab = await connect(a, b);
    connections.push(ab);
    const ac = await connect(a, c);
    connections.push(ac);
    const source = payload(1024 * 1024 + 17);
    const fid = crypto.randomUUID();
    const shared = await a.cacheApi.createCache(fid);
    await shared.setInfo({
      fileName: source.name,
      fileSize: source.size,
      chunkSize: 64 * 1024,
      file: source,
    });
    await Promise.all([
      a.service.shareFile(ab.aSession, fid),
      a.service.shareFile(ac.aSession, fid),
    ]);
    await until(
      () =>
        a.messages.length === 2 &&
        b.messages.length === 1 &&
        c.messages.length === 1 &&
        [a, b, c].every((node) =>
          node.messages.every(
            (m) => m.transferStatus === "complete",
          ),
        ),
      "shared transfer failed: " + a.errors.join(","),
    );
    await until(
      () =>
        [a, b, c].every(
          (node) => Object.keys(node.active).length === 0,
        ),
      "completed runs leaked",
    );
    const expected = await hash(source);
    for (const node of [b, c]) {
      const received = await node.caches
        .get(fid)!
        .getFile();
      assert(
        received &&
          received.size === source.size &&
          (await hash(received)) === expected,
        "shared content mismatch",
      );
    }
    assert(
      ![a, b, c].some((node) => node.errors.length),
      "unexpected shared-transfer errors",
    );

    // Pause an actual receiver while workers are processing chunks, then request
    // only the missing ranges using the existing control protocol and cache.
    const resumable = payload(8 * 1024 * 1024 + 31);
    const resumedId = crypto.randomUUID();
    const original =
      await a.cacheApi.createCache(resumedId);
    await original.setInfo({
      fileName: resumable.name,
      fileSize: resumable.size,
      chunkSize: 64 * 1024,
      file: resumable,
    });
    let paused: Promise<void> | undefined;
    b.onProgress((message) => {
      if (
        message.fid !== resumedId ||
        !message.progress?.received ||
        paused
      )
        return;
      paused = b.service.pauseFile(ab.bSession, resumedId);
    });
    await a.service.shareFile(ab.aSession, resumedId);
    await until(
      () => !!paused,
      "receiver never made progress",
    );
    await paused;
    b.onProgress();
    await until(
      () =>
        !a.registry.get(ab.aSession, resumedId) &&
        !b.registry.get(ab.bSession, resumedId),
      "pause did not release both runs",
    );
    const receiverCache = b.caches.get(resumedId)!;
    const partial = await receiverCache.calcCachedBytes();
    assert(
      partial !== null &&
        partial > 0 &&
        partial < resumable.size,
      "pause did not preserve partial data",
    );
    const metadata = await receiverCache.getInfo();
    assert(metadata, "missing resume metadata");
    await b.service.requestFile(
      ab.bSession,
      metadata,
      true,
    );
    await until(
      () =>
        [a, b].every((node) =>
          node.messages
            .filter((m) => m.fid === resumedId)
            .every((m) => m.transferStatus === "complete"),
        ),
      "resume did not finish",
    );
    const restored = await receiverCache.getFile();
    assert(
      restored &&
        (await hash(restored)) === (await hash(resumable)),
      "resumed content mismatch",
    );
    assert(
      a.transport.channels.get(ab.aSession)?.readyState ===
        "open",
      "file workflow closed chat",
    );
    report = {
      ok: true,
      transport: "real Chromium RTCDataChannel",
      cache: "real IndexedDB",
      compression: "real compression/decompression Workers",
      sharedFileBytes: source.size,
      simultaneousRecipients: 2,
      byteExactSharedCopies: true,
      resumedFileBytes: resumable.size,
      partialBytesBeforeResume: partial,
      byteExactResumedCopy: true,
      chatChannelPreserved: true,
    };
  } finally {
    for (const node of [a, b, c]) node.service.dispose();
    for (const connection of connections)
      connection.close();
    await Promise.all(
      [a, b, c].map((node) => node.close()),
    );
  }
  window.__SPEED_TEST_REPORT__ = report;
}
main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
