import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import { FileReceiver } from "@/libs/domain/transfer/file-receiver";
import { FileSender } from "@/libs/domain/transfer/file-sender";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { messageStores } from "../messaging/message-store";
import { TransferRegistry } from "./transfer-registry";
import {
  bindTransferMessage,
  finishReceivedFile,
  failTransferMessage,
} from "./transfer-message-binding";

/** Application wiring only. Run ownership is implemented by the injectable registry. */
export let transferManager: TransferRegistry;
export function createTransferManager(): TransferRegistry {
  return (transferManager ??= new TransferRegistry({
    createTransfer: ({ cache, mode, info, session }) => {
      const options = {
        cache,
        info,
        bufferedAmountLowThreshold:
          appState.options.bufferedAmountLowThreshold,
        bufferedAmountHighWaterMark:
          appState.options.bufferedAmountHighWaterMark,
      };
      return mode === TransferMode.Send
        ? new FileSender({
            ...options,
            blockSize: appState.options.blockSize,
            maxMessageSize:
              session.peerConnection?.sctp?.maxMessageSize,
            compressionLevel:
              appState.options.compressionLevel,
          })
        : new FileReceiver(options);
    },
    publish: (id, entry) =>
      setAppState("transfer", "transfers", id, entry),
    bind: (entry, signal) =>
      bindTransferMessage(entry, messageStores, signal),
    complete: async (entry, signal) => {
      if (
        entry.messageId &&
        entry.transferer.mode === TransferMode.Receive
      )
        await finishReceivedFile(
          entry.transferer.cache,
          entry.messageId,
          messageStores,
          signal,
        );
    },
    failed: (entry, error) => {
      failTransferMessage(entry, messageStores, error);
      console.error("[FileTransfer]", error);
    },
    automaticCacheDeletion: () =>
      appState.options.automaticCacheDeletion,
    reportError: (error) =>
      console.error("[FileTransfer]", error),
  }));
}
