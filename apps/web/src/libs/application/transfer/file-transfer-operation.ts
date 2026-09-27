import type { PeerSession } from "@/libs/domain/session";
import type { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { TransferRun } from "./transfer-registry";

/** Setup lifetime; the registered run may outlive the asynchronous setup. */
export interface FileTransferOperation {
  session: PeerSession;
  fileId?: string;
  mode: TransferMode;
  controller: AbortController;
  releases: Array<() => void>;
  run?: TransferRun;
}
