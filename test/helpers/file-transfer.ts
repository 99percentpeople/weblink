import { vi } from "vitest";
import type { ChunkCache } from "@/libs/cache/chunk-cache";
import type {
  ChunkCacheEventMap,
  FileMetaData,
} from "@/libs/cache";
import {
  TransferMode,
  type FileTransferer,
  type FileTransfererEventMap,
} from "@/libs/core/transfer/file-transferer";
import type { FileTransferMessage } from "@/libs/core/message";
import type { SessionMessage } from "@/libs/core/protocol/messages";
import type { PeerSession } from "@/libs/core/session";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { FileTransferStates } from "@/libs/application/transfer/file-transfer-state";
import { TransferRegistry } from "@/libs/application/transfer/transfer-registry";
import {
  bindTransferMessage,
  finishReceivedFile,
} from "@/libs/application/transfer/transfer-message-binding";

export function fileMessage(
  id = "message",
  peer = "peer",
): FileTransferMessage {
  return {
    id,
    fid: "file",
    fileName: "sample.bin",
    fileSize: 2048,
    chunkSize: 1024,
    type: "file",
    client: "local",
    target: peer,
    createdAt: 1,
    status: "received",
    transferStatus: "paused",
  };
}
export class FakeMessages {
  messages: FileTransferMessage[] = [];
  updateTransferMessage = vi.fn(
    (
      id: string,
      update: (message: FileTransferMessage) => void,
    ) => {
      const message = this.messages.find(
        (message) => message.id === id,
      );
      if (message) update(message);
    },
  );
  private store(message: SessionMessage, sending: boolean) {
    const existing = this.messages.find(
      (item) => item.id === message.id,
    );
    if (
      message.type === "ack" ||
      message.type === "error"
    ) {
      if (existing)
        Object.assign(
          existing,
          message.type === "ack"
            ? { status: "received", error: undefined }
            : { status: "error", error: message.error },
        );
      return;
    }
    if (
      message.type !== "send-file" &&
      message.type !== "request-file"
    )
      return;
    const converted: FileTransferMessage = {
      ...message,
      type: "file",
      status: sending ? "sending" : "received",
      transferStatus: "init",
      client:
        message.type === "request-file"
          ? message.target
          : message.client,
      target:
        message.type === "request-file"
          ? message.client
          : message.target,
    };
    if (existing) Object.assign(existing, converted);
    else this.messages.push(converted);
  }
  setSendMessage = vi.fn((message: SessionMessage) =>
    this.store(message, true),
  );
  retrySendMessage = vi.fn((message: SessionMessage) =>
    this.store(message, true),
  );
  setReceiveMessage = vi.fn((message: SessionMessage) =>
    this.store(message, false),
  );
}

export function fakeCache(id = "file") {
  const events =
    new MultiEventEmitter<ChunkCacheEventMap>();
  let info: FileMetaData = {
    id,
    fileName: "sample.bin",
    fileSize: 2048,
    chunkSize: 1024,
    isComplete: true,
    file: new File([new Uint8Array(2048)], "sample.bin"),
  };
  const cache = {
    id,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener:
      events.removeEventListener.bind(events),
    initialize: vi.fn(async () => {}),
    setInfo: vi.fn(async (value: Partial<FileMetaData>) => {
      info = { ...info, ...value, id };
    }),
    getInfo: vi.fn(async () => info),
    getReqRanges: vi.fn(
      async (): Promise<
        import("@/libs/utils/range").ChunkRange[]
      > => [[0, 1]],
    ),
    getFile: vi.fn(
      async (): Promise<File | null> =>
        info.file ??
        new File(
          [new Uint8Array(info.fileSize)],
          info.fileName,
        ),
    ),
    flush: vi.fn(async () => {}),
    cleanup: vi.fn(async () => {
      events.dispatchEvent("cleanup", undefined);
    }),
    getCachedKeys: vi.fn(async () => []),
    calcCachedBytes: vi.fn(async () => 0),
    getChunk: vi.fn(async () => new ArrayBuffer(1024)),
    getChunkCount: vi.fn(async () => 2),
    storeChunk: vi.fn(async () => {}),
    isTransferComplete: vi.fn(async () => false),
    mergeFile: vi.fn(async () => info.file ?? null),
  } satisfies ChunkCache;
  return cache;
}
export function fakeChannel(label = "file-0") {
  return {
    label,
    protocol: "transfer",
    readyState: "open",
    onmessage: null,
    close: vi.fn(function (this: { readyState: string }) {
      this.readyState = "closed";
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    send: vi.fn(),
  } as unknown as RTCDataChannel;
}
export function fileSession(peer = "peer"): PeerSession {
  return {
    clientId: "local",
    targetClientId: peer,
    createChannel: vi.fn(async (label: string) =>
      fakeChannel(label),
    ),
  } as unknown as PeerSession;
}
export class FakeTransfer
  extends MultiEventEmitter<FileTransfererEventMap>
  implements FileTransferer
{
  channel: RTCDataChannel | null = null;
  closed = false;
  completed = false;
  constructor(
    readonly cache: ChunkCache,
    readonly mode: TransferMode,
  ) {
    super();
  }
  get id() {
    return this.cache.id;
  }
  initialize = vi.fn(async () => {});
  sendFile = vi.fn(async (_ranges?: unknown) => {});
  setSendStatus = vi.fn(async (_message: unknown) => {});
  setChannel = vi.fn((channel: RTCDataChannel) => {
    this.channel = channel;
    if (channel.readyState === "open")
      this.dispatchEvent("ready", undefined);
  });
  close = vi.fn(() => {
    if (this.closed) return;
    this.closed = true;
    this.dispatchEvent(
      this.completed ? "complete" : "close",
      undefined,
    );
  });
  pause = vi.fn(async (_notify?: boolean) => this.close());
  finish() {
    this.completed = true;
    this.dispatchEvent("complete", undefined);
  }
}
export function registryFixture() {
  const state: FileTransferStates = {};
  const messages = new FakeMessages();
  const created: FakeTransfer[] = [];
  const report = vi.fn();
  let autoDelete = false;
  const registry = new TransferRegistry({
    createTransfer: ({ cache, mode }) => {
      const transfer = new FakeTransfer(cache, mode);
      created.push(transfer);
      return transfer;
    },
    publish: (id, entry) => {
      if (entry) state[id] = entry;
      else delete state[id];
    },
    bind: (entry, signal) =>
      bindTransferMessage(entry, messages, signal),
    complete: async (entry, signal) => {
      if (entry.transferer.mode === TransferMode.Receive)
        await finishReceivedFile(
          entry.transferer.cache,
          entry.messageId,
          messages,
          signal,
        );
    },
    failed: (entry, error) =>
      messages.updateTransferMessage(
        entry.messageId,
        (message) => {
          message.transferStatus = "error";
          message.error = error.message;
        },
      ),
    automaticCacheDeletion: () => autoDelete,
    reportError: report,
    channelTimeoutMs: 1000,
  });
  const register = (
    session = fileSession(),
    cache: ChunkCache = fakeCache(),
    messageId = "message",
    mode = TransferMode.Send,
  ) =>
    registry.register({
      session,
      cache,
      messageId,
      mode,
      incomingChannel: true,
    });
  return {
    registry,
    state,
    created,
    messages,
    report,
    register,
    setAutoDelete: (value: boolean) => {
      autoDelete = value;
    },
  };
}
