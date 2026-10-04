import { waitBufferedAmountLowThreshold } from "../utils/channel";
import { FileTransferBase } from "./file-transfer-base";
import {
  TransferMode,
  type FileTransfererOptions,
} from "./file-transferer";
import {
  encodeTransferMessage,
  parseTransferMessage,
  type CompleteMessage,
  type RequestContentMessage,
} from "./protocol";
import { getTotalChunkCount } from "@/libs/domain/file";
import { blobToArrayBuffer } from "../utils/packet";
import { readTransferPacket } from "./packet";

import UncompressWorker from "./uncompress-worker?worker";
import { catchError } from "@/libs/catch";

interface ReceiveData {
  receiveBytes: number;
  indexes: Set<number>;
}

export class FileReceiver extends FileTransferBase {
  readonly mode: TransferMode = TransferMode.Receive;
  private receivedData?: ReceiveData;
  private initialized: boolean = false;
  private lastReceiveActivityAt = Date.now();
  private receiveRevision = 0;
  private checking = false;

  private blockCache: {
    [chunkIndex: number]: {
      blocks: {
        [blockIndex: number]: Uint8Array;
      };
      receivedBlockNumber: number;
      totalBlockNumber?: number;
    };
  } = {};

  constructor(options: FileTransfererOptions) {
    super(options);
  }

  private updateProgress() {
    const info = this.info;
    if (!info) {
      return;
    }
    if (!this.receivedData) {
      console.error(
        `can not update progress, receivedData is null`,
      );
      return;
    }
    this.dispatchEvent("progress", {
      total: info.fileSize,
      received: this.receivedData.receiveBytes,
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

    const uncompressWorker = new UncompressWorker();

    uncompressWorker.onmessage = (ev) => {
      const { data, error, context } = ev.data;
      if (error) {
        console.error(error);
        return;
      }
      const chunkIndex = context?.chunkIndex;
      if (chunkIndex === undefined) {
        console.error(
          `can not store chunk, chunkIndex is undefined`,
        );
        return;
      }
      this.storeChunk(chunkIndex, data.buffer).catch(
        (storeError) => {
          console.error(storeError);
          if (storeError instanceof Error) {
            this.dispatchEvent("error", storeError);
          }
        },
      );
    };

    this.unzipWorker = uncompressWorker;

    const receivedData = {
      receiveBytes: 0,
      indexes: new Set(),
    } satisfies ReceiveData;
    this.receivedData = receivedData;
    const keys = await this.cache.getCachedKeys();
    this.assertOpen();
    keys.forEach((key) => receivedData.indexes.add(key));

    receivedData.receiveBytes =
      (await this.cache.calcCachedBytes()) ?? 0;
    this.assertOpen();

    this.updateProgress();
    if (this.channel?.readyState === "open") {
      this.dispatchEvent("ready", undefined);
    }
  }

  private async storeChunk(
    chunkIndex: number,
    chunkData: ArrayBufferLike,
  ) {
    const info = this.info;
    if (!info) {
      console.error(`can not store chunk, info is null`);

      return;
    }
    await this.cache.storeChunk(chunkIndex, chunkData);
    const receivedData = this.receivedData;
    if (!receivedData) {
      console.error(
        `can not store chunk, receivedData is null`,
      );
      return;
    }
    if (receivedData.indexes.has(chunkIndex)) {
      return;
    }
    receivedData.indexes.add(chunkIndex);
    receivedData.receiveBytes += chunkData.byteLength;
    this.updateProgress();

    this.triggerReceiveComplete();
    delete this.blockCache[chunkIndex];
  }

  private unzip(packet: ArrayBuffer) {
    if (!this.unzipWorker) {
      throw new Error("unzip worker is not initialized");
    }
    const {
      chunkIndex,
      blockIndex,
      blockData,
      isLastBlock,
    } = readTransferPacket(packet);

    if (!this.blockCache[chunkIndex]) {
      this.blockCache[chunkIndex] = {
        blocks: {},
        receivedBlockNumber: 0,
      };
    }

    const chunkInfo = this.blockCache[chunkIndex];

    chunkInfo.blocks[blockIndex] = blockData;
    chunkInfo.receivedBlockNumber += 1;

    if (isLastBlock) {
      chunkInfo.totalBlockNumber = blockIndex + 1;
    }
    if (
      chunkInfo.receivedBlockNumber ===
      chunkInfo.totalBlockNumber
    ) {
      const compressedData = assembleCompressedChunk(
        chunkInfo.blocks,
        chunkInfo.totalBlockNumber,
      );

      this.unzipWorker.postMessage(
        {
          data: compressedData,
          context: {
            chunkIndex,
          },
        },
        [compressedData.buffer as ArrayBuffer],
      );
    }
  }

  private startChecking(delay: number = 10000) {
    if (
      this.closed ||
      this.paused ||
      this.finishing ||
      this.isComplete ||
      this.checking ||
      this.timer !== undefined
    )
      return;
    const remaining = Math.max(
      0,
      delay - (Date.now() - this.lastReceiveActivityAt),
    );
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.checkMissing(delay);
    }, remaining);
  }

  private async checkMissing(delay: number) {
    if (
      this.closed ||
      this.paused ||
      this.finishing ||
      this.isComplete
    )
      return;
    if (Date.now() - this.lastReceiveActivityAt < delay) {
      this.startChecking(delay);
      return;
    }
    this.checking = true;
    const revision = this.receiveRevision;
    const current = () =>
      !this.closed &&
      !this.paused &&
      !this.finishing &&
      !this.isComplete &&
      revision === this.receiveRevision;
    try {
      this.lastReceiveActivityAt = Date.now();
      if (!this.receivedData) return;
      const done = await this.cache.isTransferComplete();
      if (!current()) return;
      if (!done) {
        const ranges = await this.cache.getReqRanges();
        if (!current()) return;
        console.log(`send request-content ranges`, ranges);

        if (ranges) {
          const msg = {
            type: "request-content",
            ranges: ranges,
          } satisfies RequestContentMessage;
          const [error, channel] = await catchError(
            this.getAvailableChannel(),
          );
          if (error) {
            if (this.closed) return;
            throw error;
          }
          if (!current()) return;
          channel.send(encodeTransferMessage(msg));
          console.log(`send msg`, msg);
        }
      }
      this.triggerReceiveComplete();
    } catch (error) {
      if (!this.closed) {
        console.error(error);
        if (error instanceof Error) {
          this.dispatchEvent("error", error);
        }
      }
    } finally {
      this.checking = false;
      this.startChecking(delay);
    }
  }

  private finishing = false;
  private triggerReceiveComplete() {
    if (!this.receivedData) return false;

    const info = this.info;
    if (!info) return false;

    const chunkslength = getTotalChunkCount(info);

    const complete =
      this.receivedData.indexes.size === chunkslength;
    if (complete) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
      if (this.isComplete || this.finishing) return true;
      console.log(`trigger receive complete`);
      this.finishing = true;

      Promise.resolve()
        .then(async () => {
          if (this.cache.verifyFile) {
            const file = await this.cache.verifyFile(
              this.controller.signal,
            );
            if (!file)
              throw new Error(
                "Received file is unavailable",
              );
          }
          this.assertOpen();
          return this.getAvailableChannel();
        })
        .then((channel) => {
          channel.send(
            encodeTransferMessage({
              type: "complete",
            } satisfies CompleteMessage),
          );
          return waitBufferedAmountLowThreshold(channel, 0);
        })
        .then(() => {
          this.isComplete = true;
          this.dispatchEvent("complete", undefined);
        })
        .catch((err) => {
          this.dispatchEvent("error", err);
          this.close();
        });
    }
    return complete;
  }

  protected handleReceiveMessage(
    data: string | ArrayBuffer | Blob,
  ) {
    try {
      if (this.closed || this.paused) return;
      this.lastReceiveActivityAt = Date.now();
      this.receiveRevision++;
      if (typeof data === "string") {
        console.log(`receiver get message`, data);
        const message = parseTransferMessage(data);
        if (message.type === "pause") {
          this.pause(false);
        } else if (message.type === "complete") {
          this.triggerReceiveComplete();
        }
      } else {
        const info = this.info;
        if (!info) return;
        let packet: ArrayBuffer | Blob = data;

        if (packet instanceof ArrayBuffer) {
          this.unzip(packet);
        } else if (packet instanceof Blob) {
          blobToArrayBuffer(packet).then((packet) =>
            this.unzip(packet),
          );
        }
      }
      this.startChecking(10000);
    } catch (error) {
      if (error instanceof Error)
        this.dispatchEvent("error", error as Error);
      console.error(error);
    }
  }
}

function assembleCompressedChunk(
  blocks: { [blockNumber: number]: Uint8Array },
  totalBlocks: number,
): Uint8Array {
  const orderedBlocks = [];

  for (let i = 0; i < totalBlocks; i++) {
    if (blocks[i]) {
      orderedBlocks.push(blocks[i]);
    } else {
      throw new Error(`Missing block ${i} in chunk`);
    }
  }

  // merge all blocks
  return concatenateUint8Arrays(orderedBlocks);
}

function concatenateUint8Arrays(
  arrays: Uint8Array[],
): Uint8Array {
  let totalLength = 0;
  arrays.forEach((arr) => (totalLength += arr.length));

  const result = new Uint8Array(totalLength);
  let offset = 0;
  arrays.forEach((arr) => {
    result.set(arr, offset);
    offset += arr.length;
  });

  return result;
}
