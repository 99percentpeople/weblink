import { waitBufferedAmountLowThreshold } from "./utils/channel";
import { FileTransferBase } from "./file-transfer-base";
import {
  TransferMode,
  type CompleteMessage,
  type FileTransfererOptions,
  type RequestContentMessage,
  type TransferMessage,
} from "./file-transferer";
import { getTotalChunkCount } from "../cache/chunk-cache";
import {
  blobToArrayBuffer,
  readPacket,
} from "./utils/packet";

import UncompressWorker from "@/libs/workers/chunk-uncompress?worker";
import { catchError } from "../catch";

interface ReceiveData {
  receiveBytes: number;
  indexes: Set<number>;
}

export class FileReceiver extends FileTransferBase {
  readonly mode: TransferMode = TransferMode.Receive;
  private receivedData?: ReceiveData;
  private initialized: boolean = false;
  private lastReceiveActivityAt = Date.now();

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
    if (this.initialized) {
      console.warn(
        `transfer ${this.cache.id} is already initialized`,
      );
    }
    this.initialized = true;

    if (!this.info) {
      this.info = await this.cache.getInfo();
    } else {
      this.cache.setInfo(this.info);
    }

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
    keys.forEach((key) => receivedData.indexes.add(key));

    receivedData.receiveBytes =
      (await this.cache.calcCachedBytes()) ?? 0;

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

    if (this.triggerReceiveComplete()) {
      window.clearInterval(this.timer);
    }
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
    } = readPacket(packet);

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

  private startChecking(delay: number = 5000) {
    if (this.timer !== undefined) return;

    const checking = async () => {
      if (this.closed || !this.receivedData) return;
      if (Date.now() - this.lastReceiveActivityAt < delay) {
        return;
      }

      this.lastReceiveActivityAt = Date.now();
      const done = await this.cache.isTransferComplete();

      if (!done) {
        const ranges = await this.cache.getReqRanges();
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
          channel.send(JSON.stringify(msg));
          console.log(`send msg`, msg);
        }
      }
      if (this.triggerReceiveComplete()) {
        window.clearInterval(this.timer);
        this.timer = undefined;
      }
    };

    const pollInterval = Math.min(delay, 1000);
    this.timer = window.setInterval(() => {
      checking().catch((error) => {
        console.error(error);
        if (error instanceof Error) {
          this.dispatchEvent("error", error);
        }
      });
    }, pollInterval);
  }

  private triggerReceiveComplete() {
    if (!this.receivedData) return false;

    const info = this.info;
    if (!info) return false;

    const chunkslength = getTotalChunkCount(info);

    const complete =
      this.receivedData.indexes.size === chunkslength;
    if (complete) {
      if (this.isComplete) return false;
      console.log(`trigger receive complete`);
      this.isComplete = true;

      this.getAvailableChannel()
        .then((channel) => {
          channel.send(
            JSON.stringify({
              type: "complete",
            } satisfies CompleteMessage),
          );
          return waitBufferedAmountLowThreshold(channel, 0);
        })
        .then(() => {
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
      this.lastReceiveActivityAt = Date.now();
      if (typeof data === "string") {
        console.log(`receiver get message`, data);
        const message = JSON.parse(data) as TransferMessage;
        if (message.type === "pause") {
          this.pause(false);
        } else if (message.type === "complete") {
          if (this.triggerReceiveComplete()) {
            window.clearInterval(this.timer);
          }
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
