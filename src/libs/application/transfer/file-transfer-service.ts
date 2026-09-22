import type {
  ChunkMetaData,
  FileMetaData,
} from "@/libs/cache";
import type { ChunkCache } from "@/libs/cache/chunk-cache";
import type { PeerSession } from "@/libs/core/session";
import type { FileTransferMessage } from "@/libs/core/message";
import type { messageStores } from "../messaging/message-store";
import {
  TransferMode,
  TRANSFER_CHANNEL_PREFIX,
} from "@/libs/core/transfer/file-transferer";
import type { FileSender } from "@/libs/core/transfer/file-sender";
import type {
  MessageMetadata,
  MessagePayload,
} from "@/libs/core/protocol/messages";
import type { RequestContext } from "@/libs/core/protocol/request-manager";
import {
  getRangesLength,
  type ChunkRange,
} from "@/libs/utils/range";
import type { RtcProtocol } from "../rtc/rtc-protocol";
import type { RtcService } from "../rtc/rtc-service";
import type { FileCacheFactory } from "../cache-service";
import type { PeerMessagingService } from "../messaging/peer-messaging-service";
import {
  TransferRegistry,
  type TransferRun,
} from "./transfer-registry";
import { finishReceivedFile } from "./transfer-message-binding";

export interface FileTransferServiceOptions {
  protocol: Pick<RtcProtocol, "call" | "handle">;
  rtc: Pick<RtcService, "onChannel" | "onSessionClosed">;
  registry: TransferRegistry;
  caches: Pick<
    FileCacheFactory,
    "getCache" | "createCache"
  >;
  messages: Pick<
    typeof messageStores,
    | "messages"
    | "setReceiveMessage"
    | "updateTransferMessage"
  >;
  messaging: Pick<PeerMessagingService, "send" | "fail">;
  getSession(peerId: string): PeerSession | undefined;
  getChunkSize(): number;
}
type Operation = {
  session: PeerSession;
  fileId?: string;
  mode: TransferMode;
  controller: AbortController;
  releases: Array<() => void>;
  run?: TransferRun;
};

/** File workflows have application lifetime, independent of dialogs and routes. */
export class FileTransferService {
  private readonly operations = new Set<Operation>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;

  constructor(
    private readonly deps: FileTransferServiceOptions,
  ) {
    this.unsubscribe = [
      deps.protocol.handle("send-file", (ctx) =>
        this.receiveFile(ctx),
      ),
      deps.protocol.handle("request-file", (ctx) =>
        this.serveFile(ctx),
      ),
      deps.protocol.handle(
        "resume-file",
        async ({ session, message, signal }) => {
          const info = await this.operation(
            session,
            undefined,
            signal,
            async (op) => {
              const cache = this.cache(op, message.fid);
              return this.step(op, cache.getInfo());
            },
          );
          if (!info)
            throw new Error(
              `cache ${message.fid} info not found`,
            );
          await this.requestFile(session, info, true, {
            signal,
          });
        },
      ),
      deps.rtc.onChannel(({ session, channel }) => {
        if (channel.protocol !== "transfer") return;
        if (
          this.disposed ||
          deps.getSession(session.targetClientId) !==
            session
        ) {
          channel.close();
          return;
        }
        // Keep the established single-channel label, with the historical prefix accepted at the boundary.
        let label = channel.label;
        if (!label.endsWith("-0")) {
          channel.close();
          return;
        }
        let fileId = label.slice(0, -2);
        if (
          !deps.registry.get(session, fileId) &&
          fileId.startsWith(TRANSFER_CHANNEL_PREFIX)
        )
          fileId = fileId.slice(
            TRANSFER_CHANNEL_PREFIX.length,
          );
        deps.registry.acceptChannel(
          session,
          fileId,
          channel,
        );
      }),
      deps.rtc.onSessionClosed((session) =>
        this.closeSession(session),
      ),
    ];
  }

  private valid(op: Operation): boolean {
    return (
      !this.disposed &&
      !op.controller.signal.aborted &&
      this.deps.getSession(op.session.targetClientId) ===
        op.session
    );
  }
  private check(op: Operation): void {
    if (!this.valid(op)) {
      const reason = op.controller.signal.reason;
      throw reason instanceof Error
        ? reason
        : new DOMException(
            "File operation cancelled",
            "AbortError",
          );
    }
    if (op.run) this.deps.registry.assertCurrent(op.run);
  }
  private async step<T>(
    op: Operation,
    work: Promise<T>,
  ): Promise<T> {
    this.check(op);
    const signal = op.controller.signal;
    let onAbort!: () => void;
    try {
      const result = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          onAbort = () =>
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new DOMException(
                    "File operation cancelled",
                    "AbortError",
                  ),
            );
          signal.addEventListener("abort", onAbort, {
            once: true,
          });
          if (signal.aborted) onAbort();
        }),
      ]);
      this.check(op);
      return result;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async operation<T>(
    session: PeerSession,
    fileId: string | undefined,
    signal: AbortSignal | undefined,
    work: (op: Operation) => Promise<T>,
    mode: TransferMode = TransferMode.Send,
  ): Promise<T> {
    const op: Operation = {
      session,
      fileId,
      mode,
      controller: new AbortController(),
      releases: [],
    };
    const abort = () => op.controller.abort();
    signal?.addEventListener("abort", abort, {
      once: true,
    });
    if (signal?.aborted) abort();
    try {
      this.check(op);
      if (fileId) {
        this.deps.registry.assertAvailable(
          session,
          fileId,
          mode,
        );
        if (
          [...this.operations].some(
            (pending) =>
              pending.fileId === fileId &&
              (pending.session === session ||
                mode === TransferMode.Receive ||
                pending.mode === TransferMode.Receive),
          )
        )
          throw new Error(
            `file ${fileId} already has an active operation`,
          );
      }
      this.operations.add(op);
      return await work(op);
    } catch (error) {
      if (op.run) {
        if (this.valid(op))
          this.deps.registry.fail(op.run, error);
        else this.deps.registry.destroy(op.run);
      }
      throw error;
    } finally {
      this.operations.delete(op);
      signal?.removeEventListener("abort", abort);
      op.releases.forEach((release) => release());
    }
  }

  private cache(op: Operation, fileId: string): ChunkCache {
    const cache = this.deps.caches.getCache(fileId);
    if (!cache)
      throw new Error(`cache ${fileId} not found`);
    this.hold(op, cache);
    return cache;
  }
  private hold(op: Operation, cache: ChunkCache): void {
    this.check(op);
    op.releases.push(this.deps.registry.retainCache(cache));
  }
  private register(
    op: Operation,
    cache: ChunkCache,
    messageId: string,
    mode: TransferMode,
    incomingChannel: boolean,
    info?: FileMetaData,
  ): TransferRun {
    this.check(op);
    const run = this.deps.registry.register({
      session: op.session,
      cache,
      messageId,
      mode,
      incomingChannel,
      info,
    });
    op.run = run;
    const cancelSetup = () =>
      op.controller.abort(run.signal.reason);
    run.signal.addEventListener("abort", cancelSetup, {
      once: true,
    });
    op.releases.push(() =>
      run.signal.removeEventListener("abort", cancelSetup),
    );
    return run;
  }
  private sendWhenReady(
    run: TransferRun,
    ranges?: ChunkRange[],
  ): void {
    run.transferer.addEventListener(
      "ready",
      () => {
        if (!this.deps.registry.isCurrent(run)) return;
        void (run.transferer as FileSender)
          .sendFile(ranges)
          .catch((error) =>
            this.deps.registry.fail(run, error),
          );
      },
      { once: true, signal: run.signal },
    );
  }

  private async outgoing<
    T extends "send-file" | "request-file",
  >(
    op: Operation,
    cache: ChunkCache,
    type: T,
    payload: MessagePayload<T>,
    metadata: MessageMetadata & { retry?: boolean } = {},
  ): Promise<void> {
    const messageId = metadata.id ?? crypto.randomUUID();
    const mode =
      type === "send-file"
        ? TransferMode.Send
        : TransferMode.Receive;
    const run = this.register(
      op,
      cache,
      messageId,
      mode,
      false,
    );
    const result = await this.step(
      op,
      this.deps.messaging
        .send(op.session, type, payload, {
          ...metadata,
          id: messageId,
          signal: op.controller.signal,
          throwOnError: true,
        })
        .catch((error) => {
          // The protocol marks an aborted pending request as failed. File cancellation is
          // instead resumable; apply its final state after that pending request settles.
          if (
            op.controller.signal.aborted &&
            op.controller.signal.reason?.name ===
              "AbortError"
          ) {
            this.deps.messages.updateTransferMessage(
              messageId,
              (message) => {
                message.status = "received";
                message.transferStatus = "paused";
                message.error = undefined;
              },
            );
          }
          throw error;
        }),
    );
    if (!result)
      throw new Error("file request was not prepared");
    try {
      if (mode === TransferMode.Send)
        this.sendWhenReady(run);
      await this.step(
        op,
        this.deps.registry.initialize(run),
      );
      // createChannel itself is not abortable: close a late result instead of attaching it to a replacement.
      const channelPromise = op.session
        .createChannel(`${cache.id}-0`, "transfer")
        .then((channel) => {
          if (
            !this.valid(op) ||
            !this.deps.registry.isCurrent(run)
          ) {
            channel.close();
            throw new DOMException(
              "File channel cancelled",
              "AbortError",
            );
          }
          return channel;
        });
      const channel = await this.step(op, channelPromise);
      this.deps.registry.setChannel(run, channel);
      this.check(op);
    } catch (error) {
      if (this.valid(op))
        this.deps.messaging.fail(result.message, error);
      throw error;
    }
  }

  sendFile(
    session: PeerSession,
    file: File,
  ): Promise<void> {
    const fid = crypto.randomUUID();
    return this.operation(
      session,
      fid,
      undefined,
      async (op) => {
        const cache = await this.step(
          op,
          this.deps.caches.createCache(fid),
        );
        this.hold(op, cache);
        const chunkSize = this.deps.getChunkSize();
        await this.step(
          op,
          cache.setInfo({
            fileName: file.name,
            fileSize: file.size,
            mimetype: file.type,
            lastModified: file.lastModified,
            chunkSize,
            createdAt: Date.now(),
            file,
          }),
        );
        await this.outgoing(op, cache, "send-file", {
          fid,
          fileName: file.name,
          fileSize: file.size,
          mimeType: file.type,
          lastModified: file.lastModified,
          chunkSize,
        });
      },
    );
  }

  shareFile(
    session: PeerSession,
    fileId: string,
  ): Promise<void> {
    return this.operation(
      session,
      fileId,
      undefined,
      async (op) => {
        const cache = this.cache(op, fileId);
        const info = await this.step(op, cache.getInfo());
        if (!info?.file)
          throw new Error(`cache ${fileId} file not found`);
        await this.outgoing(op, cache, "send-file", {
          fid: fileId,
          fileName: info.fileName,
          fileSize: info.fileSize,
          mimeType: info.mimetype,
          lastModified: info.lastModified,
          chunkSize:
            info.chunkSize ?? this.deps.getChunkSize(),
        });
      },
    );
  }

  requestFile(
    session: PeerSession,
    info: ChunkMetaData,
    resume = false,
    options: {
      signal?: AbortSignal;
      messageId?: string;
    } = {},
  ): Promise<void> {
    return this.operation(
      session,
      info.id,
      options.signal,
      async (op) => {
        let cache = this.deps.caches.getCache(info.id);
        if (!cache) {
          cache = await this.step(
            op,
            this.deps.caches.createCache(info.id),
          );
          this.hold(op, cache);
          await this.step(
            op,
            cache.setInfo({ ...info, file: undefined }),
          );
        } else this.hold(op, cache);
        const existing = resume
          ? this.deps.messages.messages.findLast(
              (message): message is FileTransferMessage =>
                message.type === "file" &&
                message.fid === info.id &&
                (!options.messageId ||
                  message.id === options.messageId) &&
                message.client === session.targetClientId &&
                message.target === session.clientId,
            )
          : undefined;
        const ranges = await this.step(
          op,
          cache.getReqRanges(),
        );
        if (ranges && getRangesLength(ranges) === 0) {
          if (existing)
            await this.step(
              op,
              finishReceivedFile(
                cache,
                existing.id,
                this.deps.messages,
                op.controller.signal,
              ),
            );
          else await this.step(op, cache.getFile());
          return;
        }
        await this.outgoing(
          op,
          cache,
          "request-file",
          {
            fid: info.id,
            ranges: ranges ?? undefined,
            fileName: info.fileName,
            fileSize: info.fileSize,
            mimeType: info.mimetype,
            lastModified: info.lastModified,
            chunkSize:
              info.chunkSize ?? this.deps.getChunkSize(),
            resume,
          },
          {
            id: existing?.id,
            createdAt:
              existing?.status === "error"
                ? existing.createdAt
                : undefined,
            retry: !!existing,
          },
        );
      },
      TransferMode.Receive,
    );
  }

  retryFile(
    session: PeerSession,
    message: FileTransferMessage,
  ): Promise<void> {
    if (!message.fid) return Promise.resolve();
    if (
      message.client === session.targetClientId &&
      message.target === session.clientId
    ) {
      return this.requestFile(
        session,
        {
          id: message.fid,
          fileName: message.fileName,
          fileSize: message.fileSize,
          mimetype: message.mimeType,
          lastModified: message.lastModified,
          chunkSize: message.chunkSize,
          createdAt: message.createdAt,
        },
        true,
        { messageId: message.id },
      );
    }
    if (
      message.client !== session.clientId ||
      message.target !== session.targetClientId
    )
      return Promise.reject(
        new Error(
          "file message does not belong to this session",
        ),
      );
    const fid = message.fid;
    return this.operation(
      session,
      fid,
      undefined,
      async (op) => {
        const cache = this.cache(op, fid);
        const info = await this.step(op, cache.getInfo());
        if (!info?.file)
          throw new Error(`cache ${fid} file not found`);
        await this.outgoing(
          op,
          cache,
          "send-file",
          {
            fid,
            fileName: message.fileName,
            fileSize: message.fileSize,
            mimeType: message.mimeType,
            lastModified: message.lastModified,
            chunkSize: message.chunkSize,
          },
          {
            id: message.id,
            createdAt: message.createdAt,
            retry: true,
          },
        );
      },
    );
  }

  resumeFile(
    session: PeerSession,
    fileId: string,
  ): Promise<void> {
    // The peer responds with a reverse request-file; do not lock this file while waiting for that request.
    return this.operation(
      session,
      undefined,
      undefined,
      async (op) => {
        const cache = this.cache(op, fileId);
        const info = await this.step(op, cache.getInfo());
        if (!info?.file)
          throw new Error(`cache ${fileId} file not found`);
        const message =
          this.deps.messages.messages.findLast(
            (message): message is FileTransferMessage =>
              message.type === "file" &&
              message.fid === fileId &&
              message.client === session.clientId &&
              message.target === session.targetClientId,
          );
        if (
          !message ||
          message.transferStatus === "complete"
        )
          return;
        await this.step(
          op,
          this.deps.protocol.call(
            session,
            "resume-file",
            { fid: fileId },
            {
              id: message.id,
              signal: op.controller.signal,
            },
          ),
        );
      },
    );
  }

  async pauseFile(
    session: PeerSession,
    fileId: string,
  ): Promise<void> {
    for (const op of this.operations) {
      if (op.session === session && op.fileId === fileId) {
        op.controller.abort();
        if (op.run) this.deps.registry.destroy(op.run);
      }
    }
    const run = this.deps.registry.get(session, fileId);
    if (run) await run.transferer.pause(true);
  }

  private receiveFile({
    session,
    message,
    signal,
  }: RequestContext<"send-file">): Promise<void> {
    return this.operation(
      session,
      message.fid,
      signal,
      async (op) => {
        if (this.deps.caches.getCache(message.fid))
          throw new Error(
            `cache ${message.fid} already exists`,
          );
        const cache = await this.step(
          op,
          this.deps.caches.createCache(message.fid),
        );
        this.hold(op, cache);
        this.deps.messages.setReceiveMessage(message);
        const run = this.register(
          op,
          cache,
          message.id,
          TransferMode.Receive,
          true,
          {
            id: message.fid,
            fileName: message.fileName,
            fileSize: message.fileSize,
            mimetype: message.mimeType,
            lastModified: message.lastModified,
            chunkSize: message.chunkSize,
            createdAt: message.createdAt,
          },
        );
        await this.step(
          op,
          this.deps.registry.initialize(run),
        );
      },
      TransferMode.Receive,
    );
  }

  private serveFile({
    session,
    message,
    signal,
  }: RequestContext<"request-file">): Promise<void> {
    return this.operation(
      session,
      message.fid,
      signal,
      async (op) => {
        const cache = this.cache(op, message.fid);
        const info = await this.step(op, cache.getInfo());
        if (!info?.isComplete)
          throw new Error(
            `cache ${message.fid} is not complete`,
          );
        this.deps.messages.setReceiveMessage(message);
        const run = this.register(
          op,
          cache,
          message.id,
          TransferMode.Send,
          true,
        );
        this.sendWhenReady(run, message.ranges);
        await this.step(
          op,
          this.deps.registry.initialize(run, () =>
            (run.transferer as FileSender).setSendStatus(
              message,
            ),
          ),
        );
      },
    );
  }

  closeSession(session: PeerSession): void {
    for (const op of this.operations)
      if (op.session === session) op.controller.abort();
    this.deps.registry.closeSession(session);
  }
  cancelAll(): void {
    for (const op of this.operations) op.controller.abort();
    this.deps.registry.clear();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe.forEach((off) => off());
    this.cancelAll();
  }
}
