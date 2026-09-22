import { waitBufferedAmountLowThreshold } from "../utils/channel";
import {
  EventHandler,
  MultiEventEmitter,
} from "@/libs/utils/event-emitter";
import { catchError } from "@/libs/catch";
import type { ChunkCache } from "@/libs/domain/file";
import type { FileMetaData } from "@/libs/domain/file";
import type {
  FileTransfererEventMap,
  FileTransfererOptions,
  PauseMessage,
  TransferMode,
} from "./file-transferer";

export abstract class FileTransferBase {
  private eventEmitter: MultiEventEmitter<FileTransfererEventMap> =
    new MultiEventEmitter();

  channel: RTCDataChannel | null = null;
  protected bufferedAmountLowThreshold = 64 * 1024; // 64KB
  protected bufferedAmountHighWaterMark = 256 * 1024; // 256KB

  readonly cache: ChunkCache;
  protected info: FileMetaData | null = null;

  protected controller: AbortController =
    new AbortController();
  protected closed = false;
  protected paused = false;
  protected isComplete = false;
  protected timer?: number;
  protected unzipWorker?: Worker;
  protected compressWorker?: Worker;

  abstract readonly mode: TransferMode;

  get id() {
    return this.cache.id;
  }

  constructor(options: FileTransfererOptions) {
    this.cache = options.cache;
    this.bufferedAmountLowThreshold =
      options.bufferedAmountLowThreshold ??
      this.bufferedAmountLowThreshold;
    this.bufferedAmountHighWaterMark = Math.max(
      options.bufferedAmountHighWaterMark ??
        this.bufferedAmountHighWaterMark,
      this.bufferedAmountLowThreshold * 4,
    );
    this.info = options.info ?? null;
  }

  addEventListener<K extends keyof FileTransfererEventMap>(
    eventName: K,
    handler: EventHandler<FileTransfererEventMap[K]>,
    options?: boolean | AddEventListenerOptions,
  ): void {
    return this.eventEmitter.addEventListener(
      eventName,
      handler,
      options,
    );
  }
  removeEventListener<
    K extends keyof FileTransfererEventMap,
  >(
    eventName: K,
    handler: EventHandler<FileTransfererEventMap[K]>,
    options?: boolean | EventListenerOptions,
  ): void {
    return this.eventEmitter.removeEventListener(
      eventName,
      handler,
      options,
    );
  }

  protected dispatchEvent<
    K extends keyof FileTransfererEventMap,
  >(eventName: K, event: FileTransfererEventMap[K]) {
    return this.eventEmitter.dispatchEvent(
      eventName,
      event,
    );
  }

  protected abstract handleReceiveMessage(
    data: string | ArrayBuffer | Blob,
  ): void;

  protected assertOpen(): void {
    if (this.closed)
      throw new Error("transferer is closed");
  }

  public setChannel(channel: RTCDataChannel) {
    this.assertOpen();
    if (
      this.channel &&
      this.channel !== channel &&
      this.channel.readyState !== "closed"
    ) {
      throw new Error("transfer channel is already set");
    }

    this.channel = channel;

    const onClose = () => {
      channel.onmessage = null;
      if (this.channel === channel) {
        this.channel = null;
      }
      if (!this.isComplete && !this.paused) {
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

    channel.addEventListener("error", onClose, {
      signal: this.controller.signal,
      once: true,
    });

    channel.onmessage = (ev) =>
      this.handleReceiveMessage(ev.data);
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold =
      this.bufferedAmountLowThreshold;

    if (channel.readyState === "open") {
      this.dispatchEvent("ready", undefined);
      return;
    }

    const controller = new AbortController();
    this.controller.signal.addEventListener(
      "abort",
      () => controller.abort(),
      { once: true },
    );
    channel.addEventListener(
      "open",
      () => {
        controller.abort();
        this.dispatchEvent("ready", undefined);
      },
      {
        signal: controller.signal,
        once: true,
      },
    );
    channel.addEventListener(
      "close",
      () => {
        controller.abort();
      },
      {
        signal: controller.signal,
        once: true,
      },
    );
  }

  protected async waitBufferedAmountLowThreshold(
    bufferedAmountLowThreshold: number = 0,
  ) {
    const channel = this.channel;
    if (!channel) {
      throw new Error("transfer channel is not set");
    }
    return waitBufferedAmountLowThreshold(
      channel,
      bufferedAmountLowThreshold,
    );
  }

  protected async getAvailableChannel(
    bufferedAmountHighWaterMark: number = this
      .bufferedAmountHighWaterMark,
  ): Promise<RTCDataChannel> {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") {
      throw new Error("transfer channel is not open");
    }

    if (
      channel.bufferedAmount <= bufferedAmountHighWaterMark
    ) {
      return channel;
    }

    const [error, availableChannel] = await catchError(
      waitBufferedAmountLowThreshold(
        channel,
        this.bufferedAmountLowThreshold,
      ),
    );
    if (error) {
      this.dispatchEvent("error", error);
      throw error;
    }
    return availableChannel;
  }

  public async pause(notify: boolean = false) {
    if (this.closed) return;

    // Mark the transfer as intentionally paused before notifying the
    // peer. Both sides can pause at nearly the same time, so the data
    // channel may close while either side is still flushing the pause
    // message. That is an expected race, not a transfer error.
    this.paused = true;

    if (notify) {
      const channel = this.channel;
      if (channel?.readyState === "open") {
        try {
          channel.send(
            JSON.stringify({
              type: "pause",
            } satisfies PauseMessage),
          );
          await waitBufferedAmountLowThreshold(channel, 0);
        } catch {
          // The peer may have processed its own pause first and closed
          // the channel while this side was flushing the notification.
        }
      }
    }
    this.close();
  }

  public close() {
    if (this.closed) return;
    this.closed = true;

    if (this.isComplete) {
      this.dispatchEvent("complete", undefined);
    } else {
      this.dispatchEvent("close", undefined);
    }
    this.unzipWorker?.terminate();
    this.compressWorker?.terminate();
    this.timer && window.clearInterval(this.timer);
    this.controller.abort();
  }
}
