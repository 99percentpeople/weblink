import { FileContentReceives } from "./file-content-receives";
import { combineAbortSignals } from "@/libs/utils/abort-signals";
import { completeLocalFile } from "./file-content-completion";
import { contentKey } from "@/libs/domain/protocol/file-fingerprint";
import type {
  FileOfferResult,
  FileContentReadyMessage,
} from "@/libs/domain/protocol/messages";
import type {
  ChunkMetaData,
  FileMetaData,
  FileSource,
} from "@/libs/domain/file";
import type { ChunkCache } from "@/libs/domain/file";
import type { PeerSession } from "@/libs/domain/session";
import type { FileTransferMessage } from "@/libs/domain/message";
import type { messageStores } from "../messaging/message-store";
import {
  TransferMode,
  TRANSFER_CHANNEL_PREFIX,
} from "@/libs/domain/transfer/file-transferer";
import type { FileSender } from "@/libs/domain/transfer/file-sender";
import type {
  MessageMetadata,
  MessagePayload,
} from "@/libs/domain/protocol/messages";
import type { RequestContext } from "@/libs/domain/protocol/request-manager";
import {
  getRangesLength,
  type ChunkRange,
} from "@/libs/utils/range";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import { FILE_TRANSFER_CHANNEL_PROTOCOL } from "@/libs/domain/transfer/protocol";
import type { RtcService } from "../rtc/rtc-service";
import type { FileCacheFactory } from "../cache-service";
import type { PeerMessagingService } from "../messaging/peer-messaging-service";
import {
  TransferRegistry,
  type TransferRun,
} from "./transfer-registry";
import { finishReceivedFile } from "./transfer-message-binding";

export interface FileTransferServiceOptions {
  protocol: Pick<WebRtcProtocol, "call" | "handle">;
  rtc: Pick<RtcService, "onChannel" | "onSessionClosed">;
  registry: TransferRegistry;
  caches: Pick<
    FileCacheFactory,
    "getCache" | "createCache"
  > &
    Partial<Pick<FileCacheFactory, "library">>;
  messages: Pick<
    typeof messageStores,
    | "messages"
    | "setReceiveMessage"
    | "updateTransferMessage"
  > &
    Partial<Pick<typeof messageStores, "flushMessage">>;
  messaging: Pick<PeerMessagingService, "send" | "fail">;
  getSession(peerId: string): PeerSession | undefined;
  getChunkSize(): number;
  automaticCacheDeletion?(): boolean;
  supportsContent?(session: PeerSession): boolean;
  validateRoomReady?(
    session: PeerSession,
    message: FileContentReadyMessage,
  ): void;
}
import type { FileTransferOperation as Operation } from "./file-transfer-operation";
import {
  FileOfferTransfers,
  type ReceiveFileOfferOptions,
  type ServeFileOfferOptions,
} from "./file-offer-transfers";

/** File workflows have application lifetime, independent of dialogs and routes. */
export class FileTransferService {
  private readonly operations = new Set<Operation>();
  private readonly unsubscribe: Array<() => void>;
  private disposed = false;
  private readonly offers: FileOfferTransfers;
  readonly contentReceives: FileContentReceives;

  constructor(
    private readonly deps: FileTransferServiceOptions,
  ) {
    this.contentReceives = new FileContentReceives(
      (run) => deps.registry.destroy(run),
      (id) => {
        for (const op of this.operations)
          if (op.fileId === id) op.controller.abort();
      },
    );
    this.offers = new FileOfferTransfers({
      ...deps,
      isDisposed: () => this.disposed,
      operation: (session, fid, signal, work, mode) =>
        this.operation(session, fid, signal, work, mode),
      step: (op, work) => this.step(op, work),
      hold: (op, cache) => this.hold(op, cache),
      register: (op, cache, id, mode, incoming) =>
        this.register(op, cache, id, mode, incoming),
      sendWhenReady: (run, ranges) =>
        this.sendWhenReady(run, ranges),
      openChannel: (op, cache) =>
        this.openChannel(op, cache),
    });
    this.unsubscribe = [
      ...(deps.caches.library
        ? [
            deps.caches.library.onRemove((ids) => {
              for (const id of ids) {
                this.contentReceives.cancel(id);
                for (const op of this.operations)
                  if (op.fileId === id)
                    op.controller.abort();
                deps.registry.destroyFile(id);
              }
            }),
          ]
        : []),
      deps.protocol.handle(
        "file-content-ready",
        async ({ session, message, signal }) => {
          const offer = deps.messages.messages.find(
            (item) => item.id === message.offerId,
          );
          if (
            !offer ||
            offer.type !== "file" ||
            offer.client !== session.clientId ||
            offer.fid !== message.fid ||
            !offer.fingerprint ||
            contentKey(offer.fingerprint) !==
              contentKey(message.fingerprint)
          )
            throw new Error("Unknown file completion");
          if (offer.room) {
            if (
              !deps.validateRoomReady ||
              message.roomId !== offer.room.roomId ||
              !Object.hasOwn(
                offer.deliveries ?? {},
                session.targetClientId,
              )
            )
              throw new Error(
                "File completion is outside the offered room",
              );
            deps.validateRoomReady(session, message);
          } else if (
            message.roomId ||
            offer.target !== session.targetClientId
          )
            throw new Error(
              "File completion peer does not match",
            );
          signal.throwIfAborted();
          completeLocalFile(
            deps.messages,
            offer.id,
            offer.room ? session.targetClientId : undefined,
          );
          await deps.messages.flushMessage?.(offer.id);
          if (
            !offer.room &&
            deps.automaticCacheDeletion?.()
          )
            await deps.caches
              .getCache(message.fid)
              ?.cleanup();
        },
      ),
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
          this.assertPrivateCache(info);
          if (
            !deps.messages.messages.some(
              (item) =>
                item.type === "file" &&
                !item.room &&
                item.fid === message.fid &&
                item.client === session.targetClientId &&
                item.target === session.clientId,
            )
          )
            throw new Error(
              "This file was not received from this peer",
            );
          await this.requestFile(session, info, true, {
            signal,
          });
        },
      ),
      deps.rtc.onChannel(({ session, channel }) => {
        if (
          channel.protocol !==
          FILE_TRANSFER_CHANNEL_PROTOCOL
        )
          return;
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
      if (
        this.operations.has(op) &&
        !op.run &&
        op.mode === TransferMode.Receive &&
        op.fileId
      )
        this.contentReceives.failFile(op.fileId, error);
      if (op.run) {
        if (this.valid(op))
          this.deps.registry.fail(op.run, error);
        else this.deps.registry.destroy(op.run);
      }
      op.controller.abort(error);
      if (
        op.mode === TransferMode.Send &&
        op.fileId &&
        !this.deps.messages.messages.some(
          (message) =>
            message.type === "file" &&
            message.fid === op.fileId,
        )
      )
        await this.deps.caches.library
          ?.releaseAttachment(op.fileId)
          .catch(console.error);
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
    if (mode === TransferMode.Receive)
      this.contentReceives.bind(run);
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
    if (
      type === "send-file" &&
      !metadata.retry &&
      !op.session.isMessageChannelReady
    )
      throw new Error(
        "The file recipient is not connected",
      );
    const messageId = metadata.id ?? crypto.randomUUID();
    const mode =
      type === "send-file"
        ? TransferMode.Send
        : TransferMode.Receive;
    const negotiated =
      type === "send-file" &&
      "fingerprint" in payload &&
      !!payload.fingerprint;
    let run = negotiated
      ? undefined
      : this.register(op, cache, messageId, mode, false);
    const result = await this.step(
      op,
      this.deps.messaging
        .send(op.session, type, payload, {
          ...metadata,
          id: messageId,
          signal: op.controller.signal,
          throwOnError: true,
          onStored:
            type === "send-file" && !metadata.retry
              ? () =>
                  this.deps.caches.library?.setShared(
                    cache.id,
                    true,
                  )
              : undefined,
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
    if (result.ackMessage.type === "file-offer-result") {
      if (result.ackMessage.disposition === "have") {
        completeLocalFile(this.deps.messages, messageId);
        await this.deps.messages.flushMessage?.(messageId);
        if (this.deps.automaticCacheDeletion?.())
          await cache.cleanup();
        return;
      }
      if (result.ackMessage.disposition === "deferred")
        return;
    }
    run ??= this.register(
      op,
      cache,
      messageId,
      mode,
      false,
    );
    try {
      if (mode === TransferMode.Send)
        this.sendWhenReady(run);
      await this.step(
        op,
        this.deps.registry.initialize(run),
      );
      await this.openChannel(op, cache);
    } catch (error) {
      if (this.valid(op))
        this.deps.messaging.fail(result.message, error);
      throw error;
    }
  }

  private async openChannel(
    op: Operation,
    cache: ChunkCache,
  ): Promise<void> {
    const run = op.run!;
    // Channel creation is not abortable; a result from a retired setup is closed.
    const channelPromise = op.session
      .createChannel(
        `${cache.id}-0`,
        FILE_TRANSFER_CHANNEL_PROTOCOL,
      )
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
  }

  private assertPrivateCache(
    info: ChunkMetaData | null,
  ): void {
    if (info?.roomAttachment)
      throw new Error(
        "Room attachments require an authorized room request",
      );
  }

  releasePreparedFile(fileId: string): Promise<void> {
    return (
      this.deps.caches.library?.releaseAttachment(fileId) ??
      Promise.resolve()
    );
  }

  prepareRoomFile(
    file: FileSource,
    origin?: { messageId: string; clientId: string },
    signal?: AbortSignal,
  ): Promise<ChunkMetaData> {
    return this.offers.prepare(file, origin, signal);
  }
  private reattach(
    fileId: string,
    messageId?: string,
  ): boolean {
    const id = this.contentReceives.reattach(
      fileId,
      messageId,
    );
    if (!id) return false;
    this.deps.messages.updateTransferMessage(
      id,
      (message) => {
        message.localContentDetached = false;
        message.transferStatus = "init";
      },
    );
    return true;
  }

  async receiveFileOffer(
    session: PeerSession,
    info: ChunkMetaData,
    options: ReceiveFileOfferOptions,
  ): Promise<void> {
    if (this.reattach(info.id, options.messageId)) return;
    if (info.fingerprint && this.deps.caches.library) {
      const stored = this.deps.messages.messages.find(
        (item) => item.id === options.messageId,
      );
      if (!stored || stored.type !== "file")
        throw new Error("File offer was removed");
      if (
        await this.reuseRoomOffer(stored, options.signal)
      ) {
        await options.reused?.();
        return;
      }
      if (
        !this.joinContent(
          session,
          stored,
          options.signal,
          options.reused,
        )
      )
        return;
    }
    try {
      await this.offers.receive(session, info, options);
    } catch (error) {
      this.contentReceives.fail(options.messageId, error);
      throw error;
    }
  }
  serveFileOffer(
    session: PeerSession,
    options: ServeFileOfferOptions,
  ): Promise<void> {
    return this.offers.serve(session, options);
  }

  private joinContent(
    session: PeerSession,
    message: FileTransferMessage,
    signal: AbortSignal,
    ready?: () => Promise<void>,
  ): boolean {
    if (!message.fingerprint || !message.fid) return true;
    const current = () =>
      !signal.aborted &&
      this.deps.getSession(session.targetClientId) ===
        session &&
      this.deps.messages.messages.some(
        (item) => item.id === message.id,
      );
    if (signal.aborted) return false;
    const leader = this.contentReceives.join(
      message.fingerprint,
      {
        id: message.id,
        fileId: message.fid,
        complete: async (waitingSignal) => {
          const { signal: activeSignal, dispose } =
            combineAbortSignals([signal, waitingSignal]);
          try {
            if (!current() || activeSignal.aborted) return;
            if (message.room) {
              if (
                !(await this.reuseRoomOffer(
                  message,
                  activeSignal,
                ))
              )
                throw new Error(
                  "Shared content is unavailable",
                );
              if (current() && !activeSignal.aborted)
                await ready?.();
            } else {
              const cache =
                await this.deps.caches.library!.reuse(
                  message.fingerprint!,
                  {
                    id: message.fid!,
                    fileName: message.fileName,
                    fileSize: message.fileSize,
                    chunkSize: message.chunkSize,
                    lastModified: message.lastModified,
                    mimetype: message.mimeType,
                    from: message.client,
                    createdAt: message.createdAt,
                  },
                  activeSignal,
                );
              if (!current() || activeSignal.aborted) {
                await cache?.cleanup();
                return;
              }
              if (!cache)
                throw new Error(
                  "Shared content is unavailable",
                );
              completeLocalFile(
                this.deps.messages,
                message.id,
              );
              await this.deps.messages.flushMessage?.(
                message.id,
              );
              if (current() && !activeSignal.aborted)
                await this.deps.protocol.call(
                  session,
                  "file-content-ready",
                  {
                    offerId: message.id,
                    fid: message.fid!,
                    fingerprint: message.fingerprint!,
                  },
                  { signal: activeSignal, retries: 2 },
                );
            }
          } finally {
            dispose();
          }
        },
        paused: (error) =>
          this.deps.messages.updateTransferMessage(
            message.id,
            (stored) => {
              stored.transferStatus = error
                ? "error"
                : "paused";
              stored.error = error
                ? String(error)
                : undefined;
              stored.localContentPending = false;
              stored.localContentDetached = true;
            },
          ),
        release: () =>
          this.deps.caches.library!.releaseAttachment(
            message.fid!,
          ),
      },
    );
    if (!leader)
      this.deps.messages.updateTransferMessage(
        message.id,
        (stored) => {
          stored.transferStatus = "init";
          stored.localContentPending = true;
          stored.localContentDetached = false;
          stored.error = undefined;
          stored.progress = undefined;
        },
      );
    return leader;
  }

  async reuseRoomOffer(
    message: FileTransferMessage,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (
      !message.fingerprint ||
      !message.fid ||
      !message.room ||
      !this.deps.caches.library
    )
      return false;
    const cache = await this.deps.caches.library.reuse(
      message.fingerprint,
      {
        id: message.fid,
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimetype: message.mimeType,
        lastModified: message.lastModified,
        chunkSize: message.chunkSize,
        roomAttachment: true,
        roomOfferId: message.id,
        from: message.client,
        createdAt: message.createdAt,
      },
      signal,
    );
    signal.throwIfAborted();
    if (!cache) return false;
    if (
      !this.deps.messages.messages.some(
        (item) => item.id === message.id,
      )
    ) {
      await cache.cleanup();
      throw new Error("The file message was removed");
    }
    completeLocalFile(this.deps.messages, message.id);
    await this.deps.messages.flushMessage?.(message.id);
    return true;
  }

  sendFile(
    session: PeerSession,
    file: FileSource,
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    if (!session.isMessageChannelReady)
      return Promise.reject(
        new Error("The file recipient is not connected"),
      );
    const fid = crypto.randomUUID();
    return this.operation(
      session,
      fid,
      options.signal,
      async (op) => {
        const chunkSize = this.deps.getChunkSize();
        let cache: ChunkCache;
        if (this.deps.caches.library) {
          cache = await this.step(
            op,
            this.deps.caches.library.prepare(
              file,
              { id: fid, chunkSize },
              { signal: op.controller.signal },
            ),
          );
        } else {
          if (!(file instanceof File))
            throw new Error("File library is unavailable");
          cache = await this.step(
            op,
            this.deps.caches.createCache(fid),
          );
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
        }
        this.hold(op, cache);
        const info = await this.step(op, cache.getInfo());
        if (!info?.isComplete)
          throw new Error("File content is unavailable");
        await this.outgoing(op, cache, "send-file", {
          fid,
          fileName: info.fileName,
          fileSize: info.fileSize,
          mimeType: info.mimetype,
          lastModified: info.lastModified,
          chunkSize,
          ...(this.deps.supportsContent?.(session) &&
          info.fingerprint
            ? { fingerprint: info.fingerprint }
            : {}),
        });
      },
    );
  }

  shareFile(
    session: PeerSession,
    fileId: string,
  ): Promise<void> {
    if (this.deps.caches.library)
      return this.sendFile(session, {
        kind: "library",
        localFileId: fileId,
      });
    return this.operation(
      session,
      fileId,
      undefined,
      async (op) => {
        const cache = this.cache(op, fileId);
        const info = await this.step(op, cache.getInfo());
        if (info?.roomAttachment) {
          if (!info.isComplete)
            throw new Error(
              `cache ${fileId} is not complete`,
            );
          const file = await this.step(op, cache.getFile());
          if (!file)
            throw new Error(
              `cache ${fileId} file not found`,
            );
          // An explicit local forward creates a distinct private share. The
          // original room-only cache keeps its authorization and retention.
          await this.step(
            op,
            this.sendFile(session, file, {
              signal: op.controller.signal,
            }),
          );
          return;
        }
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
    if (
      resume &&
      !info.roomAttachment &&
      this.reattach(info.id, options.messageId)
    )
      return Promise.resolve();
    return this.operation(
      session,
      info.id,
      options.signal,
      async (op) => {
        this.assertPrivateCache(info);
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
        if (
          existing?.fingerprint &&
          this.deps.caches.library
        ) {
          const reused = await this.step(
            op,
            this.deps.caches.library.reuse(
              existing.fingerprint,
              {
                id: existing.fid!,
                fileName: existing.fileName,
                fileSize: existing.fileSize,
                mimetype: existing.mimeType,
                lastModified: existing.lastModified,
                chunkSize: existing.chunkSize,
                from: existing.client,
                createdAt: existing.createdAt,
              },
              op.controller.signal,
            ),
          );
          if (reused) {
            if (
              !this.deps.messages.messages.some(
                (item) => item.id === existing.id,
              )
            ) {
              await reused.cleanup();
              throw new Error("File message was removed");
            }
            completeLocalFile(
              this.deps.messages,
              existing.id,
            );
            await this.deps.messages.flushMessage?.(
              existing.id,
            );
            if (this.deps.supportsContent?.(session))
              await this.step(
                op,
                this.deps.protocol.call(
                  session,
                  "file-content-ready",
                  {
                    offerId: existing.id,
                    fid: existing.fid!,
                    fingerprint: existing.fingerprint,
                  },
                  {
                    signal: op.controller.signal,
                    retries: 2,
                  },
                ),
              );
            return;
          }
          if (
            !this.joinContent(
              session,
              existing,
              op.controller.signal,
            )
          )
            return;
        }
        let cache = this.deps.caches.getCache(info.id);
        if (!cache) {
          cache = await this.step(
            op,
            this.deps.caches.createCache(info.id),
          );
          this.hold(op, cache);
          await this.step(
            op,
            cache.setInfo({
              ...info,
              from: info.from ?? session.targetClientId,
              file: undefined,
            }),
          );
        } else {
          this.hold(op, cache);
          this.assertPrivateCache(
            await this.step(op, cache.getInfo()),
          );
        }
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
    if (message.room)
      return Promise.reject(
        new Error(
          "Room attachments require an authorized room request",
        ),
      );
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
          fingerprint: message.fingerprint,
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
        this.assertPrivateCache(info);
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
            ...(this.deps.supportsContent?.(session) &&
            message.fingerprint
              ? { fingerprint: message.fingerprint }
              : {}),
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
        this.assertPrivateCache(info);
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
    if (this.contentReceives.cancel(fileId)) return;
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
  }: RequestContext<
    "send-file",
    PeerSession
  >): Promise<FileOfferResult | void> {
    return this.operation(
      session,
      message.fid,
      signal,
      async (op) => {
        const previous = this.deps.messages.messages.find(
          (item) => item.id === message.id,
        );
        if (
          previous &&
          (previous.type !== "file" ||
            previous.room ||
            previous.fid !== message.fid ||
            previous.client !== message.client ||
            previous.target !== message.target ||
            previous.fileName !== message.fileName ||
            previous.fileSize !== message.fileSize ||
            previous.chunkSize !== message.chunkSize ||
            previous.lastModified !==
              message.lastModified ||
            (previous.mimeType ?? "") !==
              (message.mimeType ?? "") ||
            JSON.stringify(previous.fingerprint) !==
              JSON.stringify(message.fingerprint))
        )
          throw new Error(
            "Conflicting file message identity",
          );
        if (
          message.fingerprint &&
          this.deps.caches.library
        ) {
          this.deps.messages.setReceiveMessage(message);
          await this.deps.messages.flushMessage?.(
            message.id,
          );
          const reused = await this.step(
            op,
            this.deps.caches.library.reuse(
              message.fingerprint,
              {
                id: message.fid,
                fileName: message.fileName,
                fileSize: message.fileSize,
                mimetype: message.mimeType,
                lastModified: message.lastModified,
                chunkSize: message.chunkSize,
                from: message.client,
                createdAt: message.createdAt,
              },
              op.controller.signal,
            ),
          );
          if (reused) {
            if (
              !this.deps.messages.messages.some(
                (item) => item.id === message.id,
              )
            ) {
              await reused.cleanup();
              throw new Error("File message was removed");
            }
            completeLocalFile(
              this.deps.messages,
              message.id,
            );
            await this.deps.messages.flushMessage?.(
              message.id,
            );
            return {
              fid: message.fid,
              disposition: "have" as const,
            };
          }
        }
        if (
          message.fingerprint &&
          this.deps.caches.library
        ) {
          const stored = this.deps.messages.messages.find(
            (item) => item.id === message.id,
          );
          if (!stored || stored.type !== "file")
            throw new Error("File message was removed");
          if (!this.joinContent(session, stored, signal))
            return {
              fid: message.fid,
              disposition: "deferred" as const,
              reason: "local-job" as const,
            };
        }
        const existing = this.deps.caches.getCache(
          message.fid,
        );
        if (existing) {
          const info = await this.step(
            op,
            existing.getInfo(),
          );
          const stored = this.deps.messages.messages.find(
            (item) => item.id === message.id,
          );
          if (
            !message.fingerprint ||
            !stored ||
            stored.type !== "file" ||
            stored.client !== message.client ||
            stored.fid !== message.fid ||
            !info ||
            info.roomAttachment ||
            info.fileName !== message.fileName ||
            info.fileSize !== message.fileSize ||
            info.chunkSize !== message.chunkSize ||
            !info.fingerprint ||
            contentKey(info.fingerprint) !==
              contentKey(message.fingerprint)
          )
            throw new Error(
              `cache ${message.fid} already exists`,
            );
        }
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
            fingerprint: message.fingerprint,
            from: message.client,
          },
        );
        await this.step(
          op,
          this.deps.registry.initialize(run),
        );
        if (message.fingerprint)
          return {
            fid: message.fid,
            disposition: "need" as const,
          };
      },
      TransferMode.Receive,
    ).catch((error) => {
      this.contentReceives.fail(message.id, error);
      throw error;
    });
  }

  private serveFile({
    session,
    message,
    signal,
  }: RequestContext<
    "request-file",
    PeerSession
  >): Promise<void> {
    return this.operation(
      session,
      message.fid,
      signal,
      async (op) => {
        const offer = this.deps.messages.messages.findLast(
          (item) =>
            item.type === "file" &&
            !item.room &&
            item.fid === message.fid &&
            item.client === session.clientId &&
            item.target === session.targetClientId,
        );
        if (
          !offer ||
          offer.type !== "file" ||
          offer.fileSize !== message.fileSize ||
          offer.fileName !== message.fileName ||
          offer.chunkSize !== message.chunkSize ||
          offer.lastModified !== message.lastModified ||
          (offer.mimeType ?? "") !==
            (message.mimeType ?? "")
        )
          throw new Error(
            "This file was not sent to this peer",
          );
        const cache = this.cache(op, message.fid);
        const info = await this.step(op, cache.getInfo());
        this.assertPrivateCache(info);
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

  releaseMessage(fileId: string): void {
    if (this.contentReceives.cancel(fileId)) return;
    for (const op of this.operations)
      if (op.fileId === fileId) op.controller.abort();
    this.deps.registry.destroyFile(fileId);
    void this.deps.caches.library
      ?.releaseAttachment(fileId)
      .catch(console.error);
  }

  closeSession(session: PeerSession): void {
    for (const message of this.deps.messages.messages)
      if (
        message.type === "file" &&
        message.client === session.targetClientId &&
        message.localContentPending &&
        message.fid
      )
        this.contentReceives.cancel(message.fid);
    for (const op of this.operations)
      if (op.session === session) op.controller.abort();
    this.deps.registry.closeSession(session);
  }
  cancelAll(): void {
    this.contentReceives.clear();
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
