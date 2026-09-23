import type { FileTransferMessage } from "@/libs/domain/message";
import type { TransferMessageStore } from "./transfer-message-binding";

export function completeLocalFile(
  store: TransferMessageStore,
  id: string,
  peerId?: string,
): void {
  store.updateTransferMessage(
    id,
    (message: FileTransferMessage) => {
      if (message.room && peerId) {
        message.roomTransfers = {
          ...message.roomTransfers,
          [peerId]: {
            status: "complete",
            completionSource: "local",
          },
        };
      } else {
        message.transferStatus = "complete";
        message.localContentPending = false;
        message.localContentDetached = false;
        message.completionSource = "local";
        message.progress = undefined;
        message.error = undefined;
        if (!message.room) message.status = "received";
      }
    },
  );
}
