import type { PeerSession } from "@/libs/domain/session";
import type { FileTransferer } from "@/libs/domain/transfer/file-transferer";
import type { FileTransferMessage } from "@/libs/domain/message";

/** A cache file is not a transfer. Every run has an owner and a message. */
export interface ActiveFileTransfer {
  readonly id: string;
  readonly session: PeerSession;
  readonly fileId: string;
  readonly messageId: string;
  readonly transferer: FileTransferer;
}

export type FileTransferStates = Record<
  string,
  ActiveFileTransfer | undefined
>;

export function findMessageTransfer(
  transfers: FileTransferStates,
  message: FileTransferMessage,
): ActiveFileTransfer | undefined {
  return Object.values(transfers).find(
    (entry) =>
      entry?.messageId === message.id &&
      entry.fileId === message.fid &&
      ((entry.session.clientId === message.client &&
        entry.session.targetClientId === message.target) ||
        (entry.session.clientId === message.target &&
          entry.session.targetClientId === message.client)),
  );
}

export function findFileTransfer(
  transfers: FileTransferStates,
  clientId: string,
  peerId: string,
  fileId: string,
): ActiveFileTransfer | undefined {
  return Object.values(transfers).find(
    (entry) =>
      entry?.session.clientId === clientId &&
      entry.session.targetClientId === peerId &&
      entry.fileId === fileId,
  );
}
