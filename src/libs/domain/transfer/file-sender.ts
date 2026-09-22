import { FileTransferBase } from "./file-transfer-base";
import {
  TransferMode,
  type FileTransfererOptions,
} from "./file-transferer";
import {
  encodeTransferMessage,
  parseTransferMessage,
  type CompleteMessage,
} from "./protocol";
import type { FileMetaData } from "@/libs/domain/file";
import { getTotalChunkCount } from "@/libs/domain/file";
import {
  type ChunkRange,
  getLastIndex,
  getRangesLength,
  getSubRanges,
  mergeRanges,
  rangesIterator,
} from "@/libs/utils/range";
import type { RequestFileMessage } from "@/libs/domain/protocol/messages";
import { buildTransferPacket } from "./packet";

import CompressWorker from "./compress-worker?worker";
import type { CompressionLevel } from "./options";
import { catchError, catchErrorSync } from "@/libs/catch";

interface SendData {
  indexes: Set<number>;
}

export class FileSender extends FileTransferBase {
  readonly mode: TransferMode = TransferMode.Send;
  private sendData?: SendData;
  private initialized: boolean = false;
  private blockSize = 128 * 1024;
  private compressionLevel: CompressionLevel = 6;

  constructor(options: FileTransfererOptions) {
    super(options);
    this.blockSize = options.blockSize ?? this.blockSize;
    this.compressionLevel =
      options.compressionLevel ?? this.compressionLevel;
  }

  private updateProgress() {
    const info = this.info;
    if (!info) {
      return;
    }
    if (!this.sendData) {
      console.error(
        `can not update progress, sendData is null`,
      );
      return;
    }
    const sendIndexes = Array.from(this.sendData.indexes);

    const ranges = mergeRanges(sendIndexes);

    this.dispatchEvent("progress", {
      total: info.fileSize,
      received: getRequestContentSize(info, ranges),
    });
  }

  public async initialize() {
    this.assertOpen();
    if (this.initialized) {
      console.warn(
        `transfer ${this.cache.id} is already initialized`,
      );
    }
    this.initialized = true;

    if (!this.info) {
      this.info = await this.cache.getInfo();
    } else {
      await this.cache.setInfo(this.info);
    }

    this.assertOpen();
    if (!this.info) {
      throw Error(
        "transfer file info is not set correctly",
      );
    }

    this.sendData = {
      indexes: new Set(),
    };

    this.updateProgress();
    if (this.channel?.readyState === "open") {
      this.dispatchEvent("ready", undefined);
    }
  }

  public async setSendStatus(message: RequestFileMessage) {
    if (!this.sendData) {
      console.error(
        `can not set send status, sendData is null`,
      );
      return;
    }
    const info = this.info;
    if (!info) {
      console.error(
        `can not set send status, info is null`,
      );
      return;
    }
    const chunkLength = getTotalChunkCount(info);
    if (message.ranges) {
      for (const index of rangesIterator(
        getSubRanges(chunkLength, message.ranges),
      )) {
        this.sendData.indexes.add(index);
      }
    }

    this.updateProgress();
  }

  public async sendFile(
    ranges?: ChunkRange[],
  ): Promise<void> {
    if (this.closed) {
      throw new Error("transferer is closed");
    }

    if (!this.sendData) {
      throw new Error(
        "file transferer is not initialized, can not send file",
      );
    }

    const info = this.info;
    if (!info) {
      throw new Error(
        "cache data is incomplete, can not send file",
      );
    }

    const totalChunks = getTotalChunkCount(info);

    let transferRange = ranges;
    console.log(`sended ranges`, transferRange);
    if (!transferRange) {
      if (totalChunks !== 0) {
        transferRange = [[0, totalChunks - 1]];
      } else {
        transferRange = [];
      }
    }
    console.log(
      `staring to send ${info.fileName}, size: ${info.fileSize}, range:`,
      transferRange,
    );

    const splitToBlocks = async (
      chunkIndex: number,
      compressedChunk: Uint8Array,
    ) => {
      const totalBlocks = Math.ceil(
        compressedChunk.byteLength / this.blockSize,
      );

      for (
        let blockIndex = 0;
        blockIndex < totalBlocks;
        blockIndex++
      ) {
        if (this.paused) return;

        const offset = blockIndex * this.blockSize;
        const isLastBlock = blockIndex === totalBlocks - 1;
        const end = Math.min(
          offset + this.blockSize,
          compressedChunk.byteLength,
        );
        const blockData = compressedChunk.subarray(
          offset,
          end,
        );

        const packet = buildTransferPacket(
          chunkIndex,
          blockIndex,
          isLastBlock,
          blockData,
        );

        const [error, channel] = await catchError(
          this.getAvailableChannel(),
        );
        if (error) {
          this.close();
          throw error;
        }
        if (this.paused) return;

        const [sendError] = catchErrorSync(() =>
          channel.send(packet),
        );
        if (sendError) {
          if (!this.closed) {
            console.error(sendError);
            this.close();
          }
          throw sendError;
        }
      }

      this.sendData?.indexes.add(chunkIndex);
      this.updateProgress();
    };

    const compressWorker = new CompressWorker();
    this.compressWorker = compressWorker;

    type CompressedChunk = {
      data: Uint8Array;
      sourceSize: number;
    };
    type PendingCompression = {
      sourceSize: number;
      resolve: (chunk: CompressedChunk) => void;
      reject: (error: Error) => void;
    };
    const pendingCompressions = new Map<
      number,
      PendingCompression
    >();

    const rejectPendingCompressions = (error: Error) => {
      for (const pending of pendingCompressions.values()) {
        pending.reject(error);
      }
      pendingCompressions.clear();
    };

    compressWorker.onmessage = (ev) => {
      const { data, error, context } = ev.data;
      const chunkIndex = context?.chunkIndex;
      if (chunkIndex === undefined) {
        rejectPendingCompressions(
          new Error(
            "can not compress chunk, chunkIndex is null",
          ),
        );
        return;
      }

      const pending = pendingCompressions.get(chunkIndex);
      if (!pending) return;
      pendingCompressions.delete(chunkIndex);

      if (error) {
        pending.reject(new Error(error));
        return;
      }
      pending.resolve({
        data,
        sourceSize: pending.sourceSize,
      });
    };
    compressWorker.onerror = () => {
      rejectPendingCompressions(
        new Error("compression worker failed"),
      );
    };
    const handleTransferAbort = () => {
      rejectPendingCompressions(
        new Error("file transfer closed"),
      );
    };
    this.controller.signal.addEventListener(
      "abort",
      handleTransferAbort,
      { once: true },
    );

    let activeCompressionLevel = this.compressionLevel;
    const compressChunk = async (
      chunkIndex: number,
    ): Promise<CompressedChunk | null> => {
      const chunk = await this.cache.getChunk(chunkIndex);
      if (!chunk) {
        console.warn(`can not get chunk ${chunkIndex}`);
        return null;
      }

      return new Promise<CompressedChunk>(
        (resolve, reject) => {
          const data = new Uint8Array(chunk);
          pendingCompressions.set(chunkIndex, {
            sourceSize: data.byteLength,
            resolve,
            reject,
          });
          compressWorker.postMessage(
            {
              data,
              option: {
                level: activeCompressionLevel,
              },
              context: {
                chunkIndex,
              },
            },
            [data.buffer as ArrayBuffer],
          );
        },
      );
    };

    const chunkIndexes = Array.from(
      rangesIterator(transferRange),
    );
    let nextCompression =
      chunkIndexes.length > 0
        ? compressChunk(chunkIndexes[0])
        : null;

    try {
      for (let i = 0; i < chunkIndexes.length; i++) {
        const compressedChunk = await nextCompression;
        if (this.paused) return;

        if (
          compressedChunk &&
          activeCompressionLevel !== 0 &&
          compressedChunk.data.byteLength >=
            compressedChunk.sourceSize * 0.95
        ) {
          activeCompressionLevel = 0;
        }

        nextCompression =
          i + 1 < chunkIndexes.length
            ? compressChunk(chunkIndexes[i + 1])
            : null;

        if (compressedChunk) {
          await splitToBlocks(
            chunkIndexes[i],
            compressedChunk.data,
          );
        }
      }
    } catch (error) {
      if (this.paused) return;
      if (!this.closed) this.close();
      throw error;
    } finally {
      this.controller.signal.removeEventListener(
        "abort",
        handleTransferAbort,
      );
      compressWorker.terminate();
      if (this.compressWorker === compressWorker) {
        this.compressWorker = undefined;
      }
    }

    const [waitError] = await catchError(
      this.waitBufferedAmountLowThreshold(0),
    );
    if (waitError) {
      return this.close();
    }
    const [error, channel] = await catchError(
      this.getAvailableChannel(),
    );
    if (error) {
      return this.close();
    }
    channel.send(
      encodeTransferMessage({
        type: "complete",
      } satisfies CompleteMessage),
    );
  }

  protected handleReceiveMessage(
    data: string | ArrayBuffer | Blob,
  ) {
    try {
      console.log(`sender get message`, data);
      if (typeof data !== "string") return;
      const message = parseTransferMessage(data);

      if (message.type === "request-content") {
        if (this.sendData) {
          for (const index of rangesIterator(
            message.ranges,
          )) {
            this.sendData.indexes.delete(index);
          }

          this.updateProgress();
        }
        this.sendFile(message.ranges);
      } else if (message.type === "complete") {
        this.isComplete = true;
        this.close();
      } else if (message.type === "pause") {
        this.pause(false);
      }
    } catch (error) {
      if (error instanceof Error)
        this.dispatchEvent("error", error as Error);
      console.error(error);
    }
  }
}

function getRequestContentSize(
  info: FileMetaData,
  ranges: ChunkRange[],
) {
  if (!info.chunkSize) {
    throw new Error("chunkSize is not found");
  }
  let requestBytes =
    getRangesLength(ranges) * info.chunkSize;
  const lastRangeIndex = getLastIndex(ranges);
  const lastChunkIndex = getTotalChunkCount(info) - 1;
  if (lastRangeIndex === lastChunkIndex) {
    requestBytes =
      requestBytes -
      info.chunkSize +
      (info.fileSize % info.chunkSize);
  }
  return requestBytes;
}
