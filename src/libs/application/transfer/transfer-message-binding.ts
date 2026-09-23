import type { ChunkCache } from "@/libs/domain/file";
import type {
  FileTransferMessage,
  RoomFileTransferState,
} from "@/libs/domain/message";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { ActiveFileTransfer } from "./file-transfer-state";

export interface TransferMessageStore {
  updateTransferMessage(
    messageId: string,
    update: (message: FileTransferMessage) => void,
  ): void;
}

/** Room uploads update only that recipient, never the shared offer's receipt. */
function updateRun(
  entry: ActiveFileTransfer,
  store: TransferMessageStore,
  update: (state: RoomFileTransferState) => void,
  complete = false,
): void {
  store.updateTransferMessage(
    entry.messageId,
    (message) => {
      if (
        message.room &&
        entry.transferer.mode === TransferMode.Send
      ) {
        const peerId = entry.session.targetClientId;
        const state = {
          ...message.roomTransfers?.[peerId],
        };
        update(state);
        message.roomTransfers = {
          ...message.roomTransfers,
          [peerId]: state,
        };
      } else {
        const state = {
          status: message.transferStatus,
          progress: message.progress,
          error: message.error,
        };
        update(state);
        message.transferStatus = state.status;
        message.progress = state.progress;
        message.error = state.error;
        if (complete && !message.room)
          message.status = "received";
      }
    },
  );
}

export function failTransferMessage(
  entry: ActiveFileTransfer,
  store: TransferMessageStore,
  error: Error,
): void {
  updateRun(entry, store, (state) => {
    state.status = "error";
    state.error = error.message;
  });
}

/** Subscriptions belong to a run; updates resolve the message ID every time. */
export function bindTransferMessage(
  entry: ActiveFileTransfer,
  store: TransferMessageStore,
  signal: AbortSignal,
): void {
  const update = (
    fn: (state: RoomFileTransferState) => void,
    complete = false,
  ) => {
    if (!signal.aborted)
      updateRun(entry, store, fn, complete);
  };
  // A metadata offer is not a transfer until a recipient explicitly starts one.
  store.updateTransferMessage(
    entry.messageId,
    (message) => {
      if (!message.room) return;
      if (entry.transferer.mode === TransferMode.Send) {
        const peerId = entry.session.targetClientId;
        message.roomTransfers = {
          ...message.roomTransfers,
          [peerId]: { status: "init" },
        };
      } else {
        message.transferStatus = "init";
        message.error = undefined;
      }
    },
  );
  const transfer = entry.transferer;
  transfer.addEventListener(
    "ready",
    () =>
      update((state) => {
        state.error = undefined;
        state.status = "transfering";
      }),
    { signal },
  );
  transfer.addEventListener(
    "progress",
    ({ detail }) =>
      update((state) => {
        state.progress = {
          total: detail.total,
          received: detail.received,
        };
        state.status = "transfering";
      }),
    { signal },
  );
  transfer.addEventListener(
    "complete",
    () => {
      if (transfer.mode !== TransferMode.Send) return;
      update((state) => {
        state.status = "complete";
        state.error = undefined;
      }, true);
    },
    { signal },
  );
  transfer.addEventListener(
    "close",
    () =>
      update((state) => {
        if (
          state.status !== "complete" &&
          state.status !== "error"
        )
          state.status = "paused";
      }),
    { signal },
  );
  transfer.addEventListener(
    "error",
    ({ detail }) =>
      update((state) => {
        state.status = "error";
        state.error = detail.message;
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
    if (!message.room) message.status = "received";
    message.transferStatus = "complete";
    message.error = undefined;
  });
}
