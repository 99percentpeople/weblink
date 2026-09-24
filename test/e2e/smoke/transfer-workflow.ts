import { FileLibraryService } from "../../../src/libs/application/file-library-service";
import { FileFingerprintService } from "../../../src/libs/application/file-fingerprint-service";
import { IndexedDbFileLibrary } from "../../../src/libs/infrastructure/storage/indexeddb-file-library";
import { completeLocalFile } from "../../../src/libs/application/transfer/file-content-completion";
import type {
  ChunkCache,
  FileMetaData,
} from "../../../src/libs/domain/file";
import { IDBChunkCache } from "../../../src/libs/infrastructure/storage/indexeddb-chunk-cache";
import { FileSender } from "../../../src/libs/domain/transfer/file-sender";
import { FileReceiver } from "../../../src/libs/domain/transfer/file-receiver";
import { TransferMode } from "../../../src/libs/domain/transfer/file-transferer";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "../../../src/libs/domain/session";
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
  failTransferMessage,
} from "../../../src/libs/application/transfer/transfer-message-binding";
import type { FileTransferStates } from "../../../src/libs/application/transfer/file-transfer-state";
import { RoomMessagingService } from "../../../src/libs/application/messaging/room-messaging-service";
import { RoomFileSharingService } from "../../../src/libs/application/messaging/room-file-sharing-service";
import { MultiEventEmitter } from "../../../src/libs/utils/event-emitter";
import { getDefaultAppOptions } from "../../../src/libs/state/app-options";

import { createRoot, createEffect } from "solid-js";
import { SharedFileTransfers } from "../../../src/libs/application/transfer/shared-file-transfers";
import {
  FileCatalogIndex,
  toCatalogMetadata,
} from "../../../src/libs/application/file-catalog-index";
import { FileCatalogService } from "../../../src/libs/application/file-catalog-service";

const transferDefaults = getDefaultAppOptions();

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
  readonly sent: SessionMessage[] = [];
  fileChannels = 0;
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
    this.sent.push(message);
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
      ++this.fileChannels;
      for (const handler of this.files)
        void handler({ session, channel });
    }
  }
}

function makeNode(
  id: string,
  roomEnabled = false,
  contentEnabled = false,
) {
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
  const rawCaches = new Map<string, ChunkCache>();
  const index = new FileCatalogIndex();
  let sharing = true;
  let library: FileLibraryService | undefined;
  const cacheApi = {
    get library() {
      return library;
    },
    getCache: (fid: string) => caches.get(fid) ?? null,
    createCache: async (
      fid: string = crypto.randomUUID(),
    ) => {
      const existing = rawCaches.get(fid);
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
      rawCaches.set(fid, scoped);
      raw.addEventListener("cleanup", () => {
        rawCaches.delete(fid);
        if (caches.get(fid) === scoped) caches.delete(fid);
      });
      if (contentEnabled) {
        let verified: Promise<File | null> | undefined;
        scoped.verifyFile = (signal) =>
          (verified ??= library!
            .verifyReceived(scoped, signal)
            .catch((error) => {
              verified = undefined;
              throw error;
            }));
      }
      caches.set(fid, scoped);
      return scoped;
    },
  };
  if (contentEnabled) {
    const fingerprints = new FileFingerprintService();
    library = new FileLibraryService({
      repository: new IndexedDbFileLibrary(
        `library-smoke-${id}`,
      ),
      fingerprint: (file, options) =>
        fingerprints.hash(file, options),
      storage: (fid) => cacheApi.createCache(fid),
      getCache: (fid) => caches.get(fid) ?? null,
      publish: async (cache) => {
        caches.set(cache.id, cache);
        cache.addEventListener("update", ({ detail }) =>
          index.update(cache.id, detail),
        );
        cache.addEventListener("cleanup", () =>
          index.update(cache.id, null),
        );
        await cache.initialize();
      },
    });
  }
  const registry = new TransferRegistry({
    createTransfer: ({ cache, mode, info, session }) =>
      mode === TransferMode.Send
        ? new FileSender({
            cache,
            info,
            blockSize: transferDefaults.blockSize,
            maxMessageSize:
              session.peerConnection?.sctp?.maxMessageSize,
            compressionLevel:
              transferDefaults.compressionLevel,
          })
        : new FileReceiver({ cache, info }),
    publish: (runId, entry) => {
      if (entry) active[runId] = entry;
      else delete active[runId];
    },
    bind: (run, signal) =>
      bindTransferMessage(run, store, signal),
    complete: async (run, signal) => {
      if (
        run.messageId &&
        run.transferer.mode === TransferMode.Receive
      )
        await finishReceivedFile(
          run.transferer.cache,
          run.messageId,
          store,
          signal,
        );
    },
    failed: (run, error) => {
      errors.push(error.message);
      failTransferMessage(run, store, error);
    },
    automaticCacheDeletion: () => roomEnabled,
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
    getChunkSize: () => transferDefaults.chunkSize,
    supportsContent: (session) =>
      contentEnabled &&
      !session.targetClientId.includes("legacy"),
    validateRoomReady: (session, message) => {
      assert(
        message.roomId &&
          message.senderToken &&
          message.recipientToken,
        "Missing room completion binding",
      );
      rooms!.validateFileBinding(session, {
        roomId: message.roomId,
        senderToken: message.senderToken,
        recipientToken: message.recipientToken,
      });
    },
  });
  const rooms = roomEnabled
    ? new RoomMessagingService(protocol, {
        supportsFiles: true,
        onFileSending: (id) =>
          library?.setShared(id, true) ?? Promise.resolve(),
        supportsContent: (session) =>
          contentEnabled &&
          !session.targetClientId.includes("legacy"),
        reuseFile: (message, signal) =>
          service.reuseRoomOffer(message, signal),
        onFileReused: async (message, peerId) => {
          completeLocalFile(store, message.id, peerId);
        },
        getRoom: () => ({
          roomId: "binary-room",
          namespace: "browser-smoke",
          conversationId: "room:browser-smoke:binary-room",
        }),
        getSessions: () => [...sessions.values()],
        getLocalClient: () => ({
          clientId: id,
          name: id,
          avatar: null,
        }),
        store: {
          async putRoomMessage(message) {
            assert(
              message.type === "file",
              "room binary fixture only stores file offers",
            );
            const previous = messages.find(
              (item) => item.id === message.id,
            );
            if (previous) {
              assert(
                previous.fid === message.fid &&
                  previous.client === message.client &&
                  previous.conversationId ===
                    message.conversationId,
                "conflicting room offer",
              );
              return false;
            }
            messages.push(structuredClone(message));
            return true;
          },
          async setRoomDelivery(messageId, peerId, status) {
            const message = messages.find(
              (item) => item.id === messageId,
            );
            assert(
              message?.deliveries,
              "room offer has no delivery snapshot",
            );
            message.deliveries[peerId] = status;
          },
        },
      })
    : undefined;
  const roomFiles = rooms
    ? new RoomFileSharingService(protocol, {
        rooms,
        files: service,
        getMessages: () => messages,
        getSession: (peerId) => sessions.get(peerId),
        getLocalClientId: () => id,
      })
    : undefined;
  const shared = library
    ? new SharedFileTransfers({
        protocol,
        rtc: transport,
        registry,
        caches: { ...cacheApi, library },
        receives: service.contentReceives,
        getSession: (peer) => sessions.get(peer),
        canShare: () => sharing,
        supports: () => true,
        reportError: (error) => errors.push(String(error)),
      })
    : undefined;
  const catalog = new FileCatalogService({
    protocol,
    index,
    getSessions: () => sessions.values(),
    isReady: (session) => session.isMessageChannelReady,
    canList: () => sharing,
    onSessionClosed: (handler) =>
      transport.onSessionClosed(handler),
  });
  return {
    shared,
    catalog,
    index,
    setSharing(value: boolean) {
      sharing = value;
      shared?.syncPermissions();
      catalog.syncSharing();
    },
    id,
    transport,
    protocol,
    sessions,
    caches,
    messages,
    active,
    registry,
    service,
    rooms,
    roomFiles,
    cacheApi,
    library,
    rawCaches,
    errors,
    onProgress: (
      handler?: (message: FileTransferMessage) => void,
    ) => {
      progressCallback = handler;
    },
    async close() {
      shared?.dispose();
      catalog.dispose();
      roomFiles?.dispose();
      rooms?.dispose();
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
  ): PeerSession => {
    const events =
      new MultiEventEmitter<PeerSessionEventMap>();
    const result = {
      clientId: local.id,
      targetClientId: remote.id,
      peerConnection: pc,
      get isMessageChannelReady() {
        return (
          local.transport.channels.get(result)
            ?.readyState === "open"
        );
      },
      addEventListener:
        events.addEventListener.bind(events),
      createChannel: async (
        label: string,
        protocol: string,
      ) => {
        const channel = pc.createDataChannel(label, {
          protocol,
          ordered: transferDefaults.ordered,
        });
        await until(
          () => channel.readyState === "open",
          "file channel open timeout",
        );
        return channel;
      },
    } as PeerSession;
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "closed")
        events.dispatchEvent("statuschange", "closed");
    });
    return result;
  };
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
    ordered: !a.rooms,
  });
  a.transport.attach(aSession, control);
  await pcA.setLocalDescription(await pcA.createOffer());
  await until(
    () => pcA.iceGatheringState === "complete",
    "offer ICE timeout",
  );
  const remoteDescription = (
    description: RTCSessionDescription,
  ) => ({
    type: description.type,
    // Exercise the real negotiated limit, including the binary packet header.
    sdp: a.rooms
      ? description.sdp.replace(
          /a=max-message-size:\d+/g,
          "a=max-message-size:32768",
        )
      : description.sdp,
  });
  await pcB.setRemoteDescription(
    remoteDescription(pcA.localDescription!),
  );
  await pcB.setLocalDescription(await pcB.createAnswer());
  await until(
    () => pcB.iceGatheringState === "complete",
    "answer ICE timeout",
  );
  await pcA.setRemoteDescription(
    remoteDescription(pcB.localDescription!),
  );
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

async function runRoomFileSmoke() {
  const sender = makeNode("room-sender", true);
  const first = makeNode("room-first", true);
  const second = makeNode("room-second", true);
  const participants = [sender, first, second];
  const connections: Awaited<ReturnType<typeof connect>>[] =
    [];
  try {
    const left = await connect(sender, first);
    connections.push(left);
    const right = await connect(sender, second);
    connections.push(right);
    assert(
      left.aSession.peerConnection?.sctp?.maxMessageSize ===
        32768 &&
        right.aSession.peerConnection?.sctp
          ?.maxMessageSize === 32768,
      "room fixture did not negotiate the constrained packet size",
    );
    participants.forEach((node) =>
      node.rooms!.syncSessions(),
    );
    await until(
      () =>
        participants.every(
          (node) =>
            node.sessions.size ===
            Object.values(
              node.rooms!.fileCapabilities,
            ).filter((value) => value === "supported")
              .length,
        ),
      "room file capabilities did not negotiate",
    );
    const source = payload(1024 * 1024 + 29);
    await sender.roomFiles!.sendFile(source);
    await until(
      () =>
        participants.every(
          (node) => node.messages.length === 1,
        ),
      "room file offer was not received by both peers",
    );
    const offered = sender.messages[0];
    const fid = offered.fid!;
    assert(
      offered.deliveries?.[first.id] === "delivered" &&
        offered.deliveries?.[second.id] === "delivered",
      "room metadata delivery receipts missing",
    );
    await sleep(100);
    assert(
      !first.caches.has(fid) && !second.caches.has(fid),
      "a metadata offer created receiver binary caches before download",
    );
    assert(
      participants.every(
        (node) =>
          node.transport.fileChannels === 0 &&
          Object.keys(node.active).length === 0,
      ),
      "a metadata offer started binary transfer channels",
    );
    assert(
      !participants.some((node) =>
        node.transport.sent.some(
          (message) => message.type === "request-room-file",
        ),
      ),
      "offer triggered automatic download",
    );

    // A peer knowing a room file id cannot use the legacy private protocol to
    // bypass the offer's room and recipient checks.
    const failures: string[] = [];
    for (const type of [
      "request-file",
      "resume-file",
    ] as const) {
      try {
        if (type === "request-file")
          await second.protocol.call(right.bSession, type, {
            fid,
            fileName: offered.fileName,
            fileSize: offered.fileSize,
            chunkSize: offered.chunkSize,
            resume: false,
          });
        else
          await second.protocol.call(right.bSession, type, {
            fid,
          });
        throw new Error(
          `legacy ${type} unexpectedly served a room-only attachment`,
        );
      } catch (error) {
        assert(
          error instanceof Error &&
            /authorized room request|not sent to this peer/.test(
              error.message,
            ),
          `unexpected ${type} rejection: ${String(error)}`,
        );
        failures.push(type);
      }
    }
    assert(
      !second.caches.has(fid),
      "legacy request created a receiver cache",
    );
    assert(
      participants.every(
        (node) => node.messages.length === 1,
      ),
      "legacy room requests created private history",
    );

    await first.roomFiles!.requestFile(first.messages[0]);
    await until(() => {
      assert(
        !participants.some((node) => node.errors.length),
        `room download failed: ${participants.flatMap((node) => node.errors).join(", ")}`,
      );
      return (
        first.messages[0].transferStatus === "complete" &&
        offered.roomTransfers?.[first.id]?.status ===
          "complete"
      );
    }, "first manual room download did not finish");
    await until(
      () =>
        [sender, first].every(
          (node) => Object.keys(node.active).length === 0,
        ),
      "first room transfer leaked a run",
    );
    const retained = await sender.caches
      .get(fid)!
      .getInfo();
    assert(
      retained?.roomAttachment === true &&
        retained.isComplete,
      "sender cache was deleted after the first recipient completed",
    );
    assert(
      !second.caches.has(fid) &&
        offered.roomTransfers?.[second.id] === undefined,
      "first download started the other recipient",
    );

    await second.roomFiles!.requestFile(second.messages[0]);
    await until(
      () =>
        second.messages[0].transferStatus === "complete" &&
        offered.roomTransfers?.[second.id]?.status ===
          "complete",
      "second manual room download did not finish",
    );
    await until(
      () =>
        participants.every(
          (node) => Object.keys(node.active).length === 0,
        ),
      "completed room transfers leaked runs",
    );
    const expected = await hash(source);
    for (const receiver of [first, second]) {
      const file = await receiver.caches
        .get(fid)!
        .getFile();
      assert(
        file &&
          file.size === source.size &&
          (await hash(file)) === expected,
        "room attachment bytes differ from the original",
      );
      const requests = receiver.transport.sent.filter(
        (message) => message.type === "request-room-file",
      );
      assert(
        requests.length === 1 &&
          requests[0].id !== offered.id,
        "download reused the room offer request id",
      );
    }
    assert(
      participants.every(
        (node) =>
          node.messages.length === 1 &&
          node.messages[0].id === offered.id &&
          node.messages[0].room?.roomId === "binary-room",
      ),
      "room download produced private or duplicate history",
    );
    assert(
      offered.deliveries?.[first.id] === "delivered" &&
        offered.deliveries?.[second.id] === "delivered",
      "download progress overwrote room offer receipts",
    );
    assert(
      !participants.some((node) => node.errors.length),
      `unexpected room transfer errors: ${participants.flatMap((node) => node.errors).join(",")}`,
    );
    return {
      participants: 3,
      negotiatedMaxMessageBytes: 32768,
      configuredPayloadBytes: transferDefaults.blockSize,
      bytes: source.size,
      metadataRecipients: 2,
      noReceiverCacheOrBinaryBeforeClick: true,
      independentManualDownloads: 2,
      byteExactCopies: true,
      senderCacheRetainedWithAutomaticDeletionEnabled: true,
      blockedLegacyRequests: failures,
      independentRequestIds: true,
      noPrivateHistoryProjection: true,
      perRecipientTransferStatus: true,
    };
  } finally {
    for (const node of participants) {
      node.roomFiles?.dispose();
      node.rooms?.dispose();
      node.service.dispose();
    }
    connections.forEach((connection) => connection.close());
    await Promise.all(
      participants.map((node) => node.close()),
    );
  }
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
  window.__SPEED_TEST_REPORT__ = {
    ...(report as Record<string, unknown>),
    roomFiles: await runRoomFileSmoke(),
    contentLibrary: await runContentLibrarySmoke(),
    sharedFiles: await runSharedFilesSmoke(),
    productionLibrary: await runProductionLibrarySmoke(),
    fingerprintBenchmark: await fingerprintBenchmark(),
  };
}
async function runProductionLibrarySmoke() {
  const [
    { FileCacheFactory },
    { appState },
    { IndexedDbMessageRepository },
    { snapshotStoreMessage },
    { createStore },
  ] = await Promise.all([
    import("../../../src/libs/application/cache-service"),
    import("../../../src/libs/state/app-state"),
    import("../../../src/libs/infrastructure/storage/indexeddb-message-repository"),
    import("../../../src/libs/application/messaging/message-snapshot"),
    import("solid-js/store"),
  ]);
  const factory = new FileCacheFactory();
  await factory.initialize();
  assert(
    !appState.cache.error,
    "production library initialization failed",
  );
  const file = new File(
    ["production persistence"],
    "library.txt",
  );
  const imported = await factory.library.importFile(file);
  const duplicate = await factory.library.importFile(
    new File([file], "alias.txt"),
  );
  assert(
    duplicate.reused &&
      duplicate.cache.id === imported.cache.id,
    "production import duplicated content",
  );
  const info = (await imported.cache.getInfo())!;
  const [message] = createStore<FileTransferMessage>({
    id: "persistent-library-offer",
    type: "file",
    client: "peer",
    target: "self",
    status: "received",
    createdAt: Date.now(),
    fid: "persistent-library-attachment",
    fileName: "received.txt",
    fileSize: file.size,
    chunkSize: 1024,
    fingerprint: info.fingerprint,
    completionSource: "local",
  });
  const reference = await factory.library.reuse(
    message.fingerprint!,
    {
      id: message.fid!,
      fileName: message.fileName,
      fileSize: message.fileSize,
      chunkSize: message.chunkSize,
      from: message.client,
    },
  );
  assert(
    reference &&
      (await reference.getFile())?.name === "received.txt",
    "reactive offer metadata failed to persist",
  );
  const repository = new IndexedDbMessageRepository();
  await repository.putMessage(
    snapshotStoreMessage(message),
  );
  const stored = (await repository.load()).messages.find(
    (item) => item.id === message.id,
  );
  assert(
    stored?.type === "file" &&
      stored.fingerprint?.digest ===
        info.fingerprint?.digest &&
      stored.completionSource === "local",
    "fingerprint receipt did not survive IndexedDB persistence",
  );
  const visible = Object.values(
    appState.cache.cacheInfo,
  ).filter((item) => item?.contentKey === info.contentKey);
  assert(
    visible.length === 2 &&
      visible.every(
        (item) => !item.contentStorage && item.isComplete,
      ),
    "production cache projection exposed hidden storage or incomplete aliases",
  );
  await factory.library.releaseAttachment(reference.id);
  assert(
    await imported.cache.getFile(),
    "releasing a message removed a pinned import",
  );
  await factory.library.removeFile(imported.cache.id);
  await repository.removeMessage(message.id);
  factory.library.dispose();
  return {
    reactiveIndexedDbPersistence: true,
    pinnedContentRetained: true,
    hiddenStorageExcluded: true,
  };
}

async function fingerprintBenchmark() {
  const service = new FileFingerprintService();
  await service.hash(new File(["warmup"], "warmup"));
  const file = new File(
    [new Uint8Array(16 * 1024 * 1024).fill(123)],
    "benchmark",
  );
  let frames = 0,
    last = performance.now(),
    maxFrameGapMs = 0,
    active = true;
  const frame = (now: number) => {
    if (!active) return;
    frames++;
    maxFrameGapMs = Math.max(maxFrameGapMs, now - last);
    last = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const start = performance.now();
  await service.hash(file);
  const blake3Ms = performance.now() - start;
  active = false;
  const shaStart = performance.now();
  await crypto.subtle.digest(
    "SHA-256",
    await file.arrayBuffer(),
  );
  const sha256Ms = performance.now() - shaStart;
  return {
    bytes: file.size,
    blake3WorkerMs: Math.round(blake3Ms),
    sha256WebCryptoMs: Math.round(sha256Ms),
    renderedFramesDuringWorker: frames,
    maxFrameGapMs: Math.round(maxFrameGapMs),
    environment:
      "headless Chromium; synthetic file, no active camera",
  };
}

async function runContentLibrarySmoke() {
  const a = makeNode("content-a", true, true);
  const b = makeNode("content-b", true, true);
  const legacy = makeNode("content-legacy", true);
  const ab = await connect(a, b);
  const al = await connect(a, legacy);
  try {
    const source = new File(
      [
        new Uint8Array(256 * 1024 + 17).map(
          (_, index) => index % 251,
        ),
      ],
      "original.bin",
      { type: "application/octet-stream", lastModified: 1 },
    );
    const local = await b.library!.importFile(
      new File([source], "renamed.bin"),
    );
    const channels = b.transport.fileChannels;
    await a.service.sendFile(ab.aSession, source);
    const first = a.messages.at(-1)!;
    await until(
      () => first.completionSource === "local",
      "local receipt not reflected at sender",
    );
    assert(
      b.transport.fileChannels === channels,
      "local hit opened a binary channel",
    );
    const received = await b.caches
      .get(first.fid!)!
      .getFile();
    assert(
      received?.name === source.name &&
        (await hash(received)) === (await hash(source)),
      "reused attachment lost its metadata or bytes",
    );
    assert(
      b.rawCaches.size === 1,
      "local hit wrote duplicate binary data",
    );
    await a.service.sendFile(ab.aSession, {
      kind: "library",
      localFileId: first.fid!,
    });
    assert(
      a.messages.at(-1)!.fid !== first.fid &&
        a.messages.at(-1)!.id !== first.id,
      "repeated sends must use independent identities",
    );
    assert(
      b.transport.fileChannels === channels,
      "repeat hit opened a binary channel",
    );
    const fresh = new File(
      ["missing content ".repeat(80000)],
      "network.txt",
    );
    await a.service.sendFile(ab.aSession, fresh);
    const network = a.messages.at(-1)!;
    await until(
      () =>
        network.transferStatus === "complete" &&
        b.messages.some(
          (m) =>
            m.id === network.id &&
            m.transferStatus === "complete",
        ),
      "verified network transfer did not complete",
    );
    assert(
      b.transport.fileChannels === channels + 1,
      "miss did not use exactly one binary channel",
    );
    assert(
      (await hash(
        (await b.caches.get(network.fid!)!.getFile())!,
      )) === (await hash(fresh)),
      "received bytes differ",
    );
    assert(
      (await b.caches.get(network.fid!)!.getInfo())
        ?.contentKey,
      "received content was not published after verification",
    );
    [a, b, legacy].forEach((node) =>
      node.rooms!.syncSessions(),
    );
    await until(
      () =>
        a.rooms?.fileCapabilities["content-b"] ===
          "supported" &&
        a.rooms?.fileCapabilities["content-legacy"] ===
          "supported",
      "room capabilities unavailable",
    );
    await a.library!.setShared(first.fid!, false);
    await a.roomFiles!.sendFile({
      kind: "library",
      localFileId: first.fid!,
    });
    const room = a.messages.at(-1)!;
    assert(
      (await a.caches.get(room.fid!)?.getInfo())?.isShared,
      "new room send did not share content",
    );
    await until(
      () =>
        room.roomTransfers?.["content-b"]
          ?.completionSource === "local",
      "room local hit receipt missing",
    );
    assert(
      b.transport.fileChannels === channels + 1,
      "room local hit transferred binary data",
    );
    const legacyOffer = legacy.messages.find(
      (item) => item.id === room.id,
    )!;
    assert(
      !legacyOffer.fingerprint,
      "new fingerprint leaked into legacy room envelope",
    );
    await legacy.roomFiles!.requestFile(legacyOffer);
    await until(
      () => legacyOffer.transferStatus === "complete",
      "mixed version room transfer failed",
    );
    assert(
      (await hash(
        (await legacy.caches
          .get(legacyOffer.fid!)!
          .getFile())!,
      )) === (await hash(source)),
      "legacy content differs",
    );
    const concurrent = new File(
      [new Uint8Array(4 * 1024 * 1024).fill(97)],
      "concurrent.bin",
    );
    const count = b.transport.fileChannels;
    await Promise.all([
      a.service.sendFile(ab.aSession, concurrent),
      a.service.sendFile(ab.aSession, concurrent),
    ]);
    const simultaneous = a.messages.slice(-2);
    await until(
      () =>
        simultaneous.every(
          (message) =>
            message.transferStatus === "complete",
        ),
      "shared receive completion missing",
    );
    assert(
      b.transport.fileChannels === count + 1,
      "concurrent content opened multiple binary channels",
    );
    assert(
      simultaneous.filter(
        (message) => message.completionSource === "local",
      ).length === 1,
      "deferred sender did not receive local completion",
    );
    await b.library!.removeFile(local.cache.id);
    assert(
      (await b.caches.get(first.fid!)!.getFile()) === null,
      "explicit delete left a readable alias",
    );
    return {
      localHitChannels: 0,
      repeatedSends: 2,
      missChannels: 1,
      verifiedBytes: fresh.size,
      roomLocalHit: true,
      mixedVersionRoom: true,
      explicitDeletion: true,
      concurrentContentChannels: 1,
      worker: "BLAKE3-256",
    };
  } finally {
    ab.close();
    al.close();
    await Promise.all([
      a.close(),
      b.close(),
      legacy.close(),
    ]);
  }
}

async function runSharedFilesSmoke() {
  const a = makeNode("shared-a", false, true);
  const b = makeNode("shared-b", false, true);
  const ab = await connect(a, b);
  let disposeEffect: (() => void) | undefined;
  try {
    const source = new File(
      [
        crypto.getRandomValues(new Uint8Array(64000)),
        new Uint8Array(2 * 1024 * 1024).fill(42),
      ],
      "shared.bin",
    );
    const local = await a.library!.importFile(source);
    assert(
      !(await local.cache.getInfo())?.isShared,
      "import unexpectedly shared content",
    );
    await a.library!.setShared(local.cache.id, true);
    let page = await b.protocol.call(
      ab.bSession,
      "request-storage",
      { pageIndex: 0, pageSize: 50 },
    );
    assert(
      page.items.length === 1,
      "shared catalog did not expose one content reference",
    );
    const info = page.items[0];
    assert(
      info.id !== local.cache.id && info.fingerprint,
      "directory reused an attachment ID",
    );
    await b.shared!.download(a.id, info);
    await until(
      () => b.shared!.tasks()[0]?.status === "completed",
      "shared pull did not complete",
    );
    assert(
      a.messages.length === 0 && b.messages.length === 0,
      "shared pull created chat messages",
    );
    const received = await Promise.all(
      [...b.caches.values()].map((cache) =>
        cache.getInfo(),
      ),
    );
    const saved = received.find(
      (item) =>
        item?.libraryPinned &&
        item.fingerprint?.digest ===
          info.fingerprint!.digest,
    );
    assert(
      saved?.file && !saved.isShared,
      "download was not private in the local library",
    );
    assert(
      (await hash(saved.file)) === (await hash(source)),
      "shared pull bytes differ",
    );
    const channels = b.transport.fileChannels;
    const localIds = [...b.caches.keys()];
    await b.shared!.download(a.id, info);
    assert(
      b.shared!.tasks().length === 1,
      "local hit created another task",
    );
    b.shared!.clearFinished();
    await b.shared!.download(a.id, {
      ...info,
      id: "another-member-alias",
    });
    assert(
      b.shared!.tasks().length === 0,
      "clearing history defeated deduplication",
    );
    assert(
      JSON.stringify([...b.caches.keys()]) ===
        JSON.stringify(localIds),
      "local hit created another file reference",
    );
    assert(
      b.transport.fileChannels === channels,
      "local hit opened a binary channel",
    );
    // Invalid IDs must fail in both the shared and historical generic APIs.
    for (const fid of [local.cache.id, "forged-file-id"]) {
      let denied = false;
      try {
        await b.protocol.call(
          ab.bSession,
          "request-shared-file",
          {
            fid,
            transferId: `shared-transfer_${crypto.randomUUID()}`,
            fingerprint: info.fingerprint!,
            chunkSize: info.chunkSize!,
            have: true,
          },
        );
      } catch {
        denied = true;
      }
      assert(denied, "forged shared ID was accepted");
    }
    let denied = false;
    try {
      await b.protocol.call(ab.bSession, "request-file", {
        fid: local.cache.id,
        fileName: source.name,
        fileSize: source.size,
        lastModified: source.lastModified,
        mimeType: source.type,
        chunkSize: info.chunkSize!,
        resume: false,
      });
    } catch {
      denied = true;
    }
    assert(
      denied,
      "legacy request exposed arbitrary cached content",
    );
    a.setSharing(false);
    page = await b.protocol.call(
      ab.bSession,
      "request-storage",
      { pageIndex: 0, pageSize: 50 },
    );
    assert(
      !page.sharingEnabled && page.totalCount === 0,
      "member permission did not hide the directory",
    );
    denied = false;
    try {
      await b.protocol.call(
        ab.bSession,
        "request-shared-file",
        {
          fid: info.id,
          transferId: `shared-transfer_${crypto.randomUUID()}`,
          fingerprint: info.fingerprint!,
          chunkSize: info.chunkSize!,
          have: true,
        },
      );
    } catch {
      denied = true;
    }
    assert(
      denied,
      "shared request bypassed revoked permission",
    );
    a.setSharing(true);
    // Pause a real receive after chunks have arrived, then resume the same task.
    const large = new File(
      [
        new Uint8Array(12 * 1024 * 1024).map(
          (_, index) => (index * 31 + (index >> 9)) % 251,
        ),
      ],
      "resume-shared.bin",
    );
    const second = await a.library!.importFile(large);
    await a.library!.setShared(second.cache.id, true);
    const secondInfo = toCatalogMetadata(
      (await a.library!.sharedFiles()).find(
        (item) => item.fileName === large.name,
      )!,
    );
    let paused = false;
    createRoot((dispose) => {
      disposeEffect = dispose;
      createEffect(() => {
        const task = b
          .shared!.tasks()
          .find((item) => item.fileName === large.name);
        if (
          !paused &&
          task &&
          task.bytes > 0 &&
          task.status === "running"
        ) {
          paused = true;
          task.pause();
        }
      });
    });
    await b.shared!.download(a.id, secondInfo);
    await until(
      () =>
        paused && !Object.values(b.active).some(Boolean),
      "shared pause did not retire the receiver",
    );
    disposeEffect?.();
    disposeEffect = undefined;
    // The sender's close event is delivered over the real data channel asynchronously.
    await until(
      () => !Object.values(a.active).some(Boolean),
      "shared sender did not observe pause",
    );
    await b
      .shared!.tasks()
      .find((task) => task.fileName === large.name)!
      .resume();
    await until(
      () =>
        b
          .shared!.tasks()
          .find((task) => task.fileName === large.name)
          ?.status === "completed",
      "shared resume did not complete",
      30000,
    );
    const resumed = (
      await Promise.all(
        [...b.caches.values()].map((cache) =>
          cache.getInfo(),
        ),
      )
    ).find(
      (item) =>
        item?.libraryPinned && item.fileName === large.name,
    );
    assert(
      resumed?.file &&
        (await hash(resumed.file)) === (await hash(large)),
      "resumed shared bytes differ",
    );
    const cancellable = new File(
      [large, new Uint8Array([1])],
      "cancel-shared.bin",
    );
    const third = await a.library!.importFile(cancellable);
    await a.library!.setShared(third.cache.id, true);
    const thirdInfo = toCatalogMetadata(
      (await a.library!.sharedFiles()).find(
        (item) => item.fileName === cancellable.name,
      )!,
    );
    let cancelledId: string | undefined;
    let cancelling: Promise<void> | undefined;
    let cancelledFileId: string | undefined;
    disposeEffect = createRoot((dispose) => {
      createEffect(() => {
        const task = b.shared!.downloadTask(
          a.id,
          thirdInfo.id,
        );
        if (
          !cancelledId &&
          task?.status === "running" &&
          task.bytes > 0
        ) {
          cancelledId = task.id;
          cancelledFileId = Object.values(b.active).find(
            (entry) => entry?.taskId === task.id,
          )?.transferer.cache.id;
          cancelling = task.cancel();
        }
      });
      return dispose;
    });
    await b.shared!.download(a.id, thirdInfo);
    await until(
      () =>
        !!cancelledId &&
        !Object.values(b.active).some(Boolean),
      "cancelled shared receive remained active",
    );
    disposeEffect?.();
    disposeEffect = undefined;
    await until(
      () => !Object.values(a.active).some(Boolean),
      "shared sender did not observe cancellation",
    );
    assert(
      b.shared!.downloadTask(a.id, thirdInfo.id)?.status ===
        "cancelled",
      "late events revived a cancelled task",
    );
    await cancelling;
    assert(
      cancelledFileId && !b.caches.has(cancelledFileId),
      "cancelled file remains in the local library",
    );
    assert(
      !(await indexedDB.databases()).some((db) =>
        db.name?.endsWith(`shared-b-${cancelledFileId}`),
      ),
      "cancelled partial cache remains in IndexedDB",
    );
    await b.shared!.download(a.id, thirdInfo);
    await until(
      () =>
        b.shared!.downloadTask(a.id, thirdInfo.id)
          ?.status === "completed",
      "new download after cancellation did not complete",
      30000,
    );
    assert(
      b.shared!.downloadTask(a.id, thirdInfo.id)?.id !==
        cancelledId,
      "cancelled task was resumed instead of starting a new download",
    );
    await a.library!.removeFile(third.cache.id);
    await a.library!.setShared(local.cache.id, false);
    denied = false;
    try {
      await b.protocol.call(
        ab.bSession,
        "request-shared-file",
        {
          fid: info.id,
          transferId: `shared-transfer_${crypto.randomUUID()}`,
          fingerprint: info.fingerprint!,
          chunkSize: info.chunkSize!,
          have: true,
        },
      );
    } catch {
      denied = true;
    }
    assert(denied, "unshared content remained authorized");
    assert(
      await local.cache.getFile(),
      "unshare deleted local content",
    );
    await a.library!.removeFile(second.cache.id);
    page = await b.protocol.call(
      ab.bSession,
      "request-storage",
      { pageIndex: 0, pageSize: 50 },
    );
    assert(
      page.items.length === 0,
      "deleted content remained listed",
    );
    assert(
      a.messages.length === 0 && b.messages.length === 0,
      "shared resume added chat history",
    );
    return {
      verifiedBytes: source.size + large.size,
      localHitChannels: 0,
      pausedAndResumed: true,
      cancelledAndRetrievedAgain: true,
      cancelledCacheDeleted: true,
      completedGetsDeduplicated: true,
      legacyBypassDenied: true,
      permissionRevoked: true,
      unsharedAndDeleted: true,
      chatMessages: 0,
    };
  } finally {
    disposeEffect?.();
    ab.close();
    await Promise.all([a.close(), b.close()]);
  }
}

main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
