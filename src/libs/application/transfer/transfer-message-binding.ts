import type { ChunkCache } from "@/libs/domain/file";
import type { FileTransferMessage } from "@/libs/domain/message";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { ActiveFileTransfer } from "./file-transfer-state";

export interface TransferMessageStore {
  updateTransferMessage(
    messageId: string,
    update: (message: FileTransferMessage) => void,
  ): void;
}

/** Subscriptions belong to a run; updates resolve the message ID every time. */
export function bindTransferMessage(
  entry: ActiveFileTransfer,
  store: TransferMessageStore,
  signal: AbortSignal,
): void {
  const update = (
    fn: (message: FileTransferMessage) => void,
  ) => {
    if (!signal.aborted)
      store.updateTransferMessage(entry.messageId, fn);
  };
  const transfer = entry.transferer;
  transfer.addEventListener(
    "ready",
    () =>
      update((message) => {
        message.error = undefined;
        message.transferStatus = "transfering";
      }),
    { signal },
  );
  transfer.addEventListener(
    "progress",
    ({ detail }) =>
      update((message) => {
        message.progress = {
          total: detail.total,
          received: detail.received,
        };
        message.transferStatus = "transfering";
      }),
    { signal },
  );
  transfer.addEventListener(
    "complete",
    () => {
      if (transfer.mode !== TransferMode.Send) return;
      update((message) => {
        message.status = "received";
        message.transferStatus = "complete";
        message.error = undefined;
      });
    },
    { signal },
  );
  transfer.addEventListener(
    "close",
    () =>
      update((message) => {
        if (
          message.transferStatus !== "complete" &&
          message.transferStatus !== "error"
        )
          message.transferStatus = "paused";
      }),
    { signal },
  );
  transfer.addEventListener(
    "error",
    ({ detail }) =>
      update((message) => {
        message.transferStatus = "error";
        message.error = detail.message;
      }),
    { signal },
  );
}

/** Completion means final cache assembly finished, not merely all frames arrived. */
export async function finishReceivedFile(
  cache: ChunkCache,
  messageId: string,
  store: TransferMessageStore,
  signal: AbortSignal,
): Promise<void> {
  await cache.flush();
  if (signal.aborted) return;
  const file = await cache.getFile();
  if (signal.aborted) return;
  if (!file)
    throw new Error(
      `cache ${cache.id} could not be assembled`,
    );
  store.updateTransferMessage(messageId, (message) => {
    message.status = "received";
    message.transferStatus = "complete";
    message.error = undefined;
  });
}
