import { waitBufferedAmountLowThreshold } from "./utils/channel";
import {
  ChunkCache,
  FileMetaData,
  ChunkMetaData,
} from "../cache/chunk-cache";
import {
  EventHandler,
  MultiEventEmitter,
} from "../utils/event-emitter";
import {
  ChunkRange,
  getLastIndex,
  getRangesLength,
  getSubRanges,
  rangesIterator,
} from "../utils/range";
import { Accessor, createSignal, Setter } from "solid-js";
import { RequestFileMessage } from "./messge";
import {
  blobToArrayBuffer,
  buildPacket,
  readPacket,
} from "./utils/packet";

import {
  deflate,
  inflate,
  gzip,
  unzip,
  Deflate,
  deflateSync,
  inflateSync,
} from "fflate";
import { CompressionLevel } from "@/options";

export enum TransferMode {
  Send = 1,
  Receive = 2,
}

export enum TransferStatus {
  New = 1,
  Ready = 2,
  Process = 3,
  Complete = 4,
  Error = 5,
}

export interface BaseTransferMessage {
  type: string;
}

export interface HeadMessage
  extends BaseTransferMessage,
    ChunkMetaData {
  type: "head";
}
export interface RequestContentMessage
  extends BaseTransferMessage {
  type: "request-content";
  ranges: ChunkRange[];
}
export interface RequestHeadMessage
  extends BaseTransferMessage {
  type: "request-head";
}

export interface CompleteMessage
  extends BaseTransferMessage {
  type: "complete";
}

export interface ReadyMessage extends BaseTransferMessage {
  type: "ready";
}

export type TransferMessage =
  | RequestContentMessage
  | RequestHeadMessage
  | HeadMessage
  | CompleteMessage
  | ReadyMessage;

interface ReceiveData {
  receiveBytes: number;
  indexes: Set<number>;
}

interface SendData {
  indexes: Set<number>;
}

export const TRANSFER_CHANNEL_PREFIX = "file-";

interface FileTransmitOptions {
  cache: ChunkCache;
  blockSize?: number;
  bufferedAmountLowThreshold?: number;
  compressionLevel?: CompressionLevel;
  mode?: TransferMode;
}

export type ProgressValue = {
  total: number;
  received: number;
};

export type FileTransmitterEventMap = {
  progress: ProgressValue;
  complete: void;
  error: Error;
  ready: void;
  close: void;
};

export class FileTransmitter {
  private eventEmitter: MultiEventEmitter<FileTransmitterEventMap> =
    new MultiEventEmitter();

  channels: Array<RTCDataChannel> = [];
  private blockSize = 128 * 1024;
  private bufferedAmountLowThreshold = 1024 * 1024; // 1MB
  private receivedData?: ReceiveData;
  private sendData?: SendData;
  private initialized: boolean = false;
  private compressionLevel: CompressionLevel = 6;

  readonly cache: ChunkCache;
  readonly status: Accessor<TransferStatus>;
  private setStatus: Setter<TransferStatus>;
  private blockCache: {
    [chunkIndex: number]: {
      blocks: {
        [blockIndex: number]: Uint8Array;
      };
      receivedBlockNumber: number;
      totalBlockNumber?: number;
    };
  } = {};
  private readyInterval?: number;
  private controller: AbortController =
    new AbortController();

  private timer?: number;
  private ready: PromiseWithResolvers<void> =
    Promise.withResolvers<void>();

  get id() {
    return this.cache.id;
  }

  readonly mode: TransferMode;

  constructor(options: FileTransmitOptions) {
    const [status, setStatus] =
      createSignal<TransferStatus>(TransferStatus.New);
    this.status = status;
    this.setStatus = setStatus;
    this.cache = options.cache;
    this.blockSize = options.blockSize ?? this.blockSize;
    this.bufferedAmountLowThreshold =
      options.bufferedAmountLowThreshold ??
      this.bufferedAmountLowThreshold;
    this.compressionLevel =
      options.compressionLevel ?? this.compressionLevel;
    this.mode = options.mode ?? TransferMode.Receive;

    this.controller.signal.addEventListener(
      "abort",
      () => {
        this.dispatchEvent("close", undefined);
      },
      { once: true },
    );
  }

  public pause() {
    if (this.status() === TransferStatus.Process) {
      this.ready = Promise.withResolvers();
      this.setStatus(TransferStatus.Ready);
    }
  }

  public setSendStatus(message: RequestFileMessage) {
    if (this.sendData) {
      const info = this.cache.info()!;
      const chunkLength = Math.ceil(
        info.fileSize / info.chunkSize,
      );
      rangesIterator(
        getSubRanges(chunkLength, message.ranges),
      ).forEach((index) =>
        this.sendData?.indexes.add(index),
      );
    }
  }

  public async initialize() {
    if (this.initialized) {
      console.warn(
        `transfer ${this.cache.id} is already initialized`,
      );
    }
    this.initialized = true;

    if (this.mode === TransferMode.Receive) {
      const receivedData = {
        receiveBytes: 0,
        indexes: new Set(),
      } satisfies ReceiveData;
      this.receivedData = receivedData;
      const keys = await this.cache.getCachedKeys();
      keys.forEach((key) => receivedData.indexes.add(key));

      const bytes = await this.cache.calcCachedBytes();
      receivedData.receiveBytes += bytes ?? 0;
      const sendReady = async () => {
        const channel =
          await this.getRandomAvailableChannel();
        channel.send(
          JSON.stringify({
            type: "ready",
          } satisfies ReadyMessage),
        );
      };
      sendReady();
      this.readyInterval = window.setInterval(
        sendReady,
        1000,
      );
    } else if (this.mode === TransferMode.Send) {
      this.sendData = {
        indexes: new Set(),
      };
    }
  }

  addEventListener<K extends keyof FileTransmitterEventMap>(
    eventName: K,
    handler: EventHandler<FileTransmitterEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      eventName,
      handler,
      options,
    );
  }
  removeEventListener<
    K extends keyof FileTransmitterEventMap,
  >(
    eventName: K,
    handler: EventHandler<FileTransmitterEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
      options,
    );
  }

  private dispatchEvent<
    K extends keyof FileTransmitterEventMap,
  >(eventName: K, event: FileTransmitterEventMap[K]) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  public addChannel(channel: RTCDataChannel) {
    const onClose = () => {
      channel.onmessage = null;
      const index = this.channels.findIndex(
        (c) => c.label === channel.label,
      );
      if (index !== -1) {
        this.channels.splice(index, 1);
      }
      if (
        this.status() !== TransferStatus.Complete &&
        this.channels.length === 0
      ) {
        this.dispatchEvent(
          "error",
          Error(`connection is closed`),
        );
      }
    };
    channel.addEventListener("close", onClose, {
      signal: this.controller.signal,
      once: true,
    });

    const info = this.cache.info()!;

    const storeChunk = async (
      chunkIndex: number,
      chunkData: ArrayBufferLike,
    ) => {
      await this.cache.storeChunk(chunkIndex, chunkData);
      this.receivedData?.indexes.add(chunkIndex);
      if (this.receivedData) {
        this.receivedData.receiveBytes +=
          chunkData.byteLength;
        this.dispatchEvent("progress", {
          total: info.fileSize,
          received: this.receivedData.receiveBytes,
        });
      }
      if (this.triggerReceiveComplete()) {
        window.clearInterval(this.timer);
      }
      delete this.blockCache[chunkIndex];
    };

    channel.onmessage = (ev) =>
      this.handleMessage(ev, (packet) => {
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
        // 检查是否收到所有块
        if (
          chunkInfo.receivedBlockNumber ===
          chunkInfo.totalBlockNumber
        ) {
          // 重组压缩区块并解压
          const compressedData = assembleCompressedChunk(
            chunkInfo.blocks,
            chunkInfo.totalBlockNumber,
          );

          inflate(compressedData, {}, (err, data) => {
            if (err) {
              console.error(err);
              return;
            }
            storeChunk(chunkIndex, data.buffer);
          });
          // storeChunk(
          //   chunkIndex,
          //   inflateSync(compressedData),
          // );
        }
      });
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold =
      this.bufferedAmountLowThreshold;

    if (this.mode === TransferMode.Receive) {
      if (channel.readyState === "open") {
        this.ready.resolve();
        this.dispatchEvent("ready", undefined);
        this.setStatus(TransferStatus.Ready);
      } else {
        channel.addEventListener(
          "open",
          () => {
            this.ready.resolve();
            this.dispatchEvent("ready", undefined);
            this.setStatus(TransferStatus.Ready);
          },
          {
            signal: this.controller.signal,
            once: true,
          },
        );
        channel.addEventListener(
          "close",
          (err) => {
            this.ready.reject(err);
          },
          {
            signal: this.controller.signal,
            once: true,
          },
        );
      }
    }

    this.channels.push(channel);
  }

  private async startChecking(interval: number = 5000) {
    const checking = async () => {
      if (!this.receivedData) {
        return;
      }
      const done = await this.cache.isDone();

      if (!done) {
        const ranges = await this.cache.getReqRanges();
        console.log(`send request-content ranges`, ranges);

        if (ranges) {
          const msg = {
            type: "request-content",
            ranges: ranges,
          } satisfies RequestContentMessage;
          const channel =
            await this.getRandomAvailableChannel();
          channel.send(JSON.stringify(msg));
          console.log(`send msg`, msg);
        }
      }
      if (this.triggerReceiveComplete()) {
        window.clearInterval(this.timer);
      }
    };
    window.clearInterval(this.timer);
    this.timer = window.setInterval(checking, interval);
  }

  private triggerReceiveComplete() {
    if (this.mode === TransferMode.Send) return false;
    if (!this.receivedData) return false;

    const info = this.cache.info();
    if (!info) return false;

    const chunkslength = Math.ceil(
      info.fileSize / info.chunkSize,
    );

    const complete =
      this.receivedData.indexes.size === chunkslength;
    if (complete) {
      if (this.status() === TransferStatus.Complete)
        return false;
      console.log(`trigger receive complete`);
      this.setStatus(TransferStatus.Complete);
      this.getRandomAvailableChannel()
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
        });
    }
    return complete;
  }

  // wait all channels bufferedAmountLowThreshold
  private async waitBufferedAmountLowThreshold(
    bufferedAmountLowThreshold: number = 0,
  ) {
    return Promise.all(
      this.channels.map((channel) =>
        waitBufferedAmountLowThreshold(
          channel,
          bufferedAmountLowThreshold,
        ),
      ),
    );
  }

  // random select a available dataChannel
  private async getRandomAvailableChannel(
    bufferedAmountLowThreshold: number = this
      .bufferedAmountLowThreshold,
  ): Promise<RTCDataChannel> {
    const channel = await Promise.any(
      this.channels.map((channel) => {
        channel.bufferedAmountLowThreshold =
          bufferedAmountLowThreshold;
        return new Promise<RTCDataChannel>(
          async (reslove) => {
            if (
              channel.bufferedAmount <=
              channel.bufferedAmountLowThreshold
            ) {
              return reslove(channel);
            }

            channel.addEventListener(
              "bufferedamountlow",
              () => reslove(channel),
              {
                once: true,
                signal: this.controller.signal,
              },
            );
          },
        );
      }),
    );
    return channel;
  }

  // send file
  public async sendFile(
    ranges?: ChunkRange[],
  ): Promise<void> {
    if (this.mode !== TransferMode.Send) {
      this.dispatchEvent(
        "error",
        new Error("transferer is not in send mode"),
      );
      return;
    }

    if (!this.sendData) {
      this.dispatchEvent(
        "error",
        new Error("必须先调用init初始化"),
      );
      return;
    }

    const info = this.cache.info();
    if (!info) {
      this.dispatchEvent(
        "error",
        new Error(
          "cache data is incomplete, can not send file",
        ),
      );

      return;
    }

    const totalChunks = Math.ceil(
      info.fileSize / info.chunkSize,
    );

    let transferRange = ranges;
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

    this.setStatus(TransferStatus.Process);

    const spliteToBlock = async (
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
        const offset = blockIndex * this.blockSize;
        const isLastBlock = blockIndex === totalBlocks - 1;
        const end = Math.min(
          offset + this.blockSize,
          compressedChunk.byteLength,
        );
        const blockData = compressedChunk.slice(
          offset,
          end,
        );

        const packet = buildPacket(
          chunkIndex,
          blockIndex,
          isLastBlock,
          blockData.buffer,
        );

        const channel =
          await this.getRandomAvailableChannel();

        channel.send(packet);
      }
      if (this.sendData) {
        this.sendData.indexes.add(chunkIndex);

        this.dispatchEvent("progress", {
          total: info.fileSize,
          received: getRequestContentSize(
            info,
            this.sendData.indexes.values().toArray(),
          ),
        });
      }
    };
    let queue = Promise.resolve();
    function enqueueTask(task: () => Promise<void>) {
      queue = queue.then(() => task());
    }
    for (const chunkIndex of rangesIterator(
      transferRange,
    )) {
      const chunk = await this.cache.getChunk(chunkIndex);
      if (chunk) {
        deflate(
          new Uint8Array(chunk),
          { level: this.compressionLevel },
          (err, data) => {
            if (err) {
              console.error(err);
              return;
            }
            enqueueTask(() =>
              spliteToBlock(chunkIndex, data),
            );
          },
        );
        // spliteToBlock(
        //   chunkIndex,
        //   deflateSync(new Uint8Array(chunk), {
        //     level: this.compressionLevel,
        //   }),
        // );
      } else {
        console.warn(`can not get chunk ${chunkIndex}`);
      }
    }
    await queue;
    await this.waitBufferedAmountLowThreshold(0);
    const channel = await this.getRandomAvailableChannel();
    channel.send(
      JSON.stringify({
        type: "complete",
      } satisfies CompleteMessage),
    );
    this.setStatus(TransferStatus.Complete);
  }

  // handle receive message
  private handleMessage(
    event: MessageEvent,
    unzipCB: (packet: ArrayBuffer) => void,
  ) {
    if (this.readyInterval) {
      clearInterval(this.readyInterval);
      this.readyInterval = undefined;
    }
    try {
      this.setStatus(TransferStatus.Process);

      if (this.mode === TransferMode.Receive) {
        if (typeof event.data === "string") {
          console.log(`receiver get message`, event.data);
          const message = JSON.parse(
            event.data,
          ) as TransferMessage;
          if (message.type === "complete") {
            if (this.triggerReceiveComplete()) {
              window.clearInterval(this.timer);
            }
          }
        } else {
          const info = this.cache.info();
          if (!info) return;
          let packet: ArrayBuffer | Blob = event.data;

          if (packet instanceof ArrayBuffer) {
            unzipCB(packet);
          } else if (packet instanceof Blob) {
            blobToArrayBuffer(packet).then((packet) =>
              unzipCB(packet),
            );
          }
        }
        this.startChecking(10000);
      } else if (this.mode === TransferMode.Send) {
        console.log(`sender get message`, event.data);
        if (typeof event.data !== "string") return;
        const message = JSON.parse(
          event.data,
        ) as TransferMessage;

        if (message.type === "request-content") {
          if (this.status() !== TransferStatus.Process) {
            if (this.sendData) {
              rangesIterator(message.ranges).forEach(
                (index) =>
                  this.sendData?.indexes.delete(index),
              );
              const info = this.cache.info();
              if (info) {
                this.dispatchEvent("progress", {
                  total: info.fileSize,
                  received: getRequestContentSize(
                    info,
                    this.sendData.indexes
                      .values()
                      .toArray(),
                  ),
                });
              }
            }
            this.sendFile(message.ranges);
          } else {
            console.log(
              "send not complete, ignore request-content message",
            );
          }
        } else if (message.type === "complete") {
          this.setStatus(TransferStatus.Complete);
          this.dispatchEvent("complete", undefined);
        } else if (message.type === "ready") {
          this.ready?.resolve();
          this.dispatchEvent("ready", undefined);
        }
      }
    } catch (error) {
      if (error instanceof Error)
        this.dispatchEvent("error", error as Error);
      console.error(error);
    }
  }

  public destroy() {
    this.controller.abort();
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

function getRequestContentSize(
  info: FileMetaData,
  ranges: ChunkRange[],
) {
  let requestBytes =
    getRangesLength(ranges) * info.chunkSize;
  const lastRangeIndex = getLastIndex(ranges);
  const lastChunkIndex =
    Math.ceil(info.fileSize / info.chunkSize) - 1;
  if (lastRangeIndex === lastChunkIndex) {
    requestBytes =
      requestBytes -
      info.chunkSize +
      (info.fileSize % info.chunkSize);
  }
  return requestBytes;
}
