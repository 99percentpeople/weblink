import {
  TransferMode,
  type FileTransferer,
} from "../core/file-transferer";
import { FileReceiver } from "../core/file-receiver";
import { FileSender } from "../core/file-sender";
import { FileID } from "../core/type";
import { ChunkCache } from "../cache/chunk-cache";
import { FileMetaData } from "../cache";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

class TransfererFactory {
  readonly transferers: Record<FileID, FileTransferer> =
    appState.transfer.transferers;
  private pendingChannels: Record<
    FileID,
    RTCDataChannel | undefined
  > = {};

  getTransferer(id: FileID) {
    if (this.transferers[id]) {
      return this.transferers[id];
    }

    return null;
  }

  setChannel(fileId: FileID, channel: RTCDataChannel) {
    const transfer = this.transferers[fileId];
    if (transfer) {
      if (
        transfer.channel &&
        transfer.channel !== channel &&
        transfer.channel.readyState !== "closed"
      ) {
        channel.close();
        return;
      }
      transfer.setChannel(channel);
      return;
    }

    const pendingChannel = this.pendingChannels[fileId];
    if (
      pendingChannel &&
      pendingChannel !== channel &&
      pendingChannel.readyState !== "closed"
    ) {
      channel.close();
      return;
    }

    this.pendingChannels[fileId] = channel;
    channel.addEventListener(
      "close",
      () => {
        if (this.pendingChannels[fileId] === channel) {
          delete this.pendingChannels[fileId];
        }
      },
      { once: true },
    );
  }

  destroyTransfer(id: FileID) {
    const transferer = this.transferers[id];
    if (!transferer) {
      this.pendingChannels[id]?.close();
      delete this.pendingChannels[id];
      console.log(`transferer ${id} not exist`);
      return;
    }

    const channel = transferer.channel;
    transferer.close();
    channel?.close();
    delete this.pendingChannels[id];
    setAppState("transfer", "transferers", id, undefined!);
  }

  createTransfer(cache: ChunkCache): FileReceiver;
  createTransfer(
    cache: ChunkCache,
    mode: TransferMode.Receive,
    info?: FileMetaData,
  ): FileReceiver;
  createTransfer(
    cache: ChunkCache,
    mode: TransferMode.Send,
    info?: FileMetaData,
  ): FileSender;
  createTransfer(
    cache: ChunkCache,
    mode: TransferMode = TransferMode.Receive,
    info?: FileMetaData,
  ) {
    const fileId = cache.id;
    const tf = this.getTransferer(fileId);
    if (tf) {
      this.destroyTransfer(tf.id);
    }

    const transferer =
      mode === TransferMode.Send
        ? new FileSender({
            cache,
            info,
            bufferedAmountLowThreshold:
              appState.options.bufferedAmountLowThreshold,
            bufferedAmountHighWaterMark:
              appState.options.bufferedAmountHighWaterMark,
            blockSize: appState.options.blockSize,
            compressionLevel:
              appState.options.compressionLevel,
          })
        : new FileReceiver({
            cache,
            info,
            bufferedAmountLowThreshold:
              appState.options.bufferedAmountLowThreshold,
            bufferedAmountHighWaterMark:
              appState.options.bufferedAmountHighWaterMark,
          });

    const flushInterval = setInterval(() => {
      cache.flush();
    }, 1000);

    const controller = new AbortController();

    transferer.addEventListener(
      "complete",
      async () => {
        clearInterval(flushInterval);
        if (transferer.mode === TransferMode.Receive) {
          await cache.flush();
          cache.getFile();
        } else {
          if (appState.options.automaticCacheDeletion)
            cache.cleanup();
        }
        this.destroyTransfer(transferer.id);

        controller.abort();
      },
      { once: true, signal: controller.signal },
    );

    transferer.addEventListener(
      "error",
      async (event) => {
        console.error(event.detail);
        clearInterval(flushInterval);
        this.destroyTransfer(transferer.id);
        if (transferer.mode === TransferMode.Receive) {
          cache.flush();
        }
      },
      {
        once: true,
        signal: controller.signal,
      },
    );

    transferer.addEventListener(
      "close",
      () => {
        controller.abort();
        clearInterval(flushInterval);
        this.destroyTransfer(transferer.id);
      },
      {
        once: true,
        signal: controller.signal,
      },
    );

    setAppState(
      "transfer",
      "transferers",
      fileId,
      transferer,
    );

    const pendingChannel = this.pendingChannels[fileId];
    if (pendingChannel) {
      delete this.pendingChannels[fileId];
      if (pendingChannel.readyState !== "closed") {
        transferer.setChannel(pendingChannel);
      }
    }

    return transferer;
  }
}

export let transferManager: TransfererFactory;

export function createTransferManager() {
  if (!transferManager) {
    transferManager = new TransfererFactory();
  }
  return transferManager;
}
