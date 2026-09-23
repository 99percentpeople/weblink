import type {
  ChunkCache,
  ChunkMetaData,
  FileMetaData,
  FileSource,
} from "@/libs/domain/file";
import type { FileTransferMessage } from "@/libs/domain/message";
import type { PeerSession } from "@/libs/domain/session";
import type { FileSender } from "@/libs/domain/transfer/file-sender";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import {
  getRangesLength,
  type ChunkRange,
} from "@/libs/utils/range";
import type { FileTransferServiceOptions } from "./file-transfer-service";
import type { FileTransferOperation } from "./file-transfer-operation";
import type { TransferRun } from "./transfer-registry";
import { finishReceivedFile } from "./transfer-message-binding";

export interface ReceiveFileOfferOptions {
  reused?(): Promise<void>;
  messageId: string;
  signal: AbortSignal;
  request(
    ranges: ChunkRange[] | undefined,
    signal: AbortSignal,
  ): Promise<void>;
}
export interface ServeFileOfferOptions {
  fid: string;
  messageId: string;
  ranges?: ChunkRange[];
  resume: boolean;
  signal: AbortSignal;
  info?: ChunkMetaData;
}
interface FileOfferTransferDependencies extends Pick<
  FileTransferServiceOptions,
  "caches" | "messages" | "registry" | "getChunkSize"
> {
  isDisposed(): boolean;
  operation<T>(
    session: PeerSession,
    fileId: string,
    signal: AbortSignal,
    work: (op: FileTransferOperation) => Promise<T>,
    mode: TransferMode,
  ): Promise<T>;
  step<T>(
    op: FileTransferOperation,
    work: Promise<T>,
  ): Promise<T>;
  hold(op: FileTransferOperation, cache: ChunkCache): void;
  register(
    op: FileTransferOperation,
    cache: ChunkCache,
    messageId: string,
    mode: TransferMode,
    incoming: boolean,
  ): TransferRun;
  sendWhenReady(
    run: TransferRun,
    ranges?: ChunkRange[],
  ): void;
  openChannel(
    op: FileTransferOperation,
    cache: ChunkCache,
  ): Promise<void>;
}

/** Room authorization and offer delivery stay in the room service; only bytes live here. */
export class FileOfferTransfers {
  constructor(
    private readonly deps: FileOfferTransferDependencies,
  ) {}

  async prepare(
    file: FileSource,
    origin?: { messageId: string; clientId: string },
    signal?: AbortSignal,
  ): Promise<ChunkMetaData> {
    if (this.deps.isDisposed())
      throw new DOMException(
        "File service disposed",
        "AbortError",
      );
    if (this.deps.caches.library) {
      const cache = await this.deps.caches.library.prepare(
        file,
        {
          chunkSize: this.deps.getChunkSize(),
          roomAttachment: true,
          roomOfferId: origin?.messageId,
          from: origin?.clientId,
        },
        { signal },
      );
      const info = await cache.getInfo();
      if (!info)
        throw new Error("File content is unavailable");
      return info;
    }
    if (!(file instanceof File))
      throw new Error("File library is unavailable");
    const info: ChunkMetaData = {
      id: crypto.randomUUID(),
      fileName: file.name,
      fileSize: file.size,
      mimetype: file.type,
      lastModified: file.lastModified,
      chunkSize: this.deps.getChunkSize(),
      createdAt: Date.now(),
      roomAttachment: true,
      roomOfferId: origin?.messageId,
      from: origin?.clientId,
    };
    const cache = await this.deps.caches.createCache(
      info.id,
    );
    try {
      if (this.deps.isDisposed())
        throw new DOMException(
          "File service disposed",
          "AbortError",
        );
      await cache.setInfo({ ...info, file });
      if (this.deps.isDisposed())
        throw new DOMException(
          "File service disposed",
          "AbortError",
        );
      return info;
    } catch (error) {
      await cache.cleanup().catch(() => {});
      throw error;
    }
  }

  private message(
    session: PeerSession,
    id: string,
    fid: string,
    receiving: boolean,
  ): FileTransferMessage {
    const message = this.deps.messages.messages.find(
      (item) => item.id === id,
    );
    if (
      !message ||
      message.type !== "file" ||
      !message.room ||
      message.fid !== fid ||
      message.client !==
        (receiving
          ? session.targetClientId
          : session.clientId) ||
      (receiving && message.target !== session.clientId)
    )
      throw new Error(
        "Unknown room file offer for this peer",
      );
    return message;
  }

  private assertMetadata(
    actual: ChunkMetaData | null,
    expected: ChunkMetaData,
  ): asserts actual is ChunkMetaData {
    if (
      !actual?.roomAttachment ||
      actual.id !== expected.id ||
      JSON.stringify(actual.fingerprint) !==
        JSON.stringify(expected.fingerprint) ||
      actual.roomOfferId !== expected.roomOfferId ||
      actual.from !== expected.from ||
      actual.fileName !== expected.fileName ||
      actual.fileSize !== expected.fileSize ||
      actual.chunkSize !== expected.chunkSize ||
      actual.lastModified !== expected.lastModified ||
      (actual.mimetype ?? "") !== (expected.mimetype ?? "")
    )
      throw new Error(
        "Room attachment cache metadata does not match the offer",
      );
  }

  private info(
    message: FileTransferMessage,
  ): ChunkMetaData {
    return {
      id: message.fid!,
      fileName: message.fileName,
      fileSize: message.fileSize,
      mimetype: message.mimeType,
      lastModified: message.lastModified,
      chunkSize: message.chunkSize,
      fingerprint: message.fingerprint,
      roomAttachment: true,
      roomOfferId: message.id,
      from: message.client,
    };
  }

  private ownRun(
    run: TransferRun,
    signal: AbortSignal,
  ): void {
    const cancel = () => this.deps.registry.destroy(run);
    signal.addEventListener("abort", cancel, {
      once: true,
      signal: run.signal,
    });
    if (signal.aborted) cancel();
  }

  receive(
    session: PeerSession,
    info: ChunkMetaData,
    options: ReceiveFileOfferOptions,
  ): Promise<void> {
    return this.deps.operation(
      session,
      info.id,
      options.signal,
      async (op) => {
        const message = this.message(
          session,
          options.messageId,
          info.id,
          true,
        );
        this.assertMetadata(info, this.info(message));
        let cache = this.deps.caches.getCache(info.id);
        if (cache) {
          this.deps.hold(op, cache);
          this.assertMetadata(
            await this.deps.step(op, cache.getInfo()),
            info,
          );
        } else {
          cache = await this.deps.step(
            op,
            this.deps.caches.createCache(info.id),
          );
          this.deps.hold(op, cache);
          await this.deps.step(
            op,
            cache.setInfo({
              ...info,
              file: undefined,
              roomAttachment: true,
            }),
          );
        }
        try {
          const ranges = await this.deps.step(
            op,
            cache.getReqRanges(),
          );
          // Recheck ownership after asynchronous storage work: deleting an offer
          // must not create a new hidden transfer for the removed message.
          this.message(
            session,
            options.messageId,
            info.id,
            true,
          );
          if (ranges && getRangesLength(ranges) === 0) {
            await this.deps.step(
              op,
              finishReceivedFile(
                cache,
                options.messageId,
                this.deps.messages,
                op.controller.signal,
              ),
            );
            return;
          }
          const run = this.deps.register(
            op,
            cache,
            options.messageId,
            TransferMode.Receive,
            false,
          );
          this.ownRun(run, options.signal);
          await this.deps.step(
            op,
            options.request(
              ranges ?? undefined,
              op.controller.signal,
            ),
          );
          await this.deps.step(
            op,
            this.deps.registry.initialize(run),
          );
          await this.deps.openChannel(op, cache);
        } catch (error) {
          if (!op.run)
            this.deps.messages.updateTransferMessage(
              options.messageId,
              (stored) => {
                stored.transferStatus = op.controller.signal
                  .aborted
                  ? "paused"
                  : "error";
                stored.error = op.controller.signal.aborted
                  ? undefined
                  : error instanceof Error
                    ? error.message
                    : String(error);
              },
            );
          throw error;
        }
      },
      TransferMode.Receive,
    );
  }

  serve(
    session: PeerSession,
    options: ServeFileOfferOptions,
  ): Promise<void> {
    return this.deps.operation(
      session,
      options.fid,
      options.signal,
      async (op) => {
        const message = this.message(
          session,
          options.messageId,
          options.fid,
          false,
        );
        const cache = this.deps.caches.getCache(
          options.fid,
        );
        if (!cache)
          throw new Error(`cache ${options.fid} not found`);
        this.deps.hold(op, cache);
        const info = await this.deps.step(
          op,
          cache.getInfo(),
        );
        this.assertMetadata(info, this.info(message));
        if (options.info)
          this.assertMetadata(info, options.info);
        if (!(info as FileMetaData).isComplete)
          throw new Error(
            `cache ${options.fid} is not complete`,
          );
        const totalChunks = Math.ceil(
          info.fileSize / info.chunkSize!,
        );
        if (
          options.ranges?.some((range) =>
            (Array.isArray(range) ? range : [range]).some(
              (index) =>
                !Number.isSafeInteger(index) ||
                index < 0 ||
                index >= totalChunks,
            ),
          )
        )
          throw new Error(
            "Requested room file ranges are out of bounds",
          );
        this.message(
          session,
          options.messageId,
          options.fid,
          false,
        );
        const run = this.deps.register(
          op,
          cache,
          options.messageId,
          TransferMode.Send,
          true,
        );
        this.ownRun(run, options.signal);
        this.deps.sendWhenReady(run, options.ranges);
        await this.deps.step(
          op,
          this.deps.registry.initialize(run, () =>
            (run.transferer as FileSender).setSendStatus({
              type: "request-file",
              id: options.messageId,
              client: session.targetClientId,
              target: session.clientId,
              createdAt: message.createdAt,
              fid: options.fid,
              fileName: info.fileName,
              fileSize: info.fileSize,
              mimeType: info.mimetype,
              lastModified: info.lastModified,
              chunkSize: info.chunkSize!,
              ranges: options.ranges,
              resume: options.resume,
            }),
          ),
        );
      },
      TransferMode.Send,
    );
  }
}
