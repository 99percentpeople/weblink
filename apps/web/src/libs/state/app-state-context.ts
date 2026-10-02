import {
  createContext,
  useContext,
  type Accessor,
} from "solid-js";
import type { ConversationMessagingService } from "@/libs/application/messaging/conversation-messaging-service";
import type { ConversationHistoryService } from "@/libs/application/messaging/conversation-history-service";
import type { FileCatalogService } from "@/libs/application/file-catalog-service";
import type { SharedFileTransfers } from "@/libs/application/transfer/shared-file-transfers";
import type { TaskService } from "@/libs/application/task-service";
import type { SpeedTestState } from "@/libs/application/speed-test-service";
import type { SpeedTestApprovalRequest } from "@/components/speed-test-approval";
import type {
  ChunkMetaData,
  FileSource,
} from "@/libs/domain/file";
import type { ClientID, FileID } from "@/libs/domain/ids";
import type { PeerSession } from "@/libs/domain/session";
import type { ClientJoinOptions } from "@/libs/domain/client";
import type {
  FileTransferMessage,
  StoreMessage,
} from "@/libs/domain/message";
import type { RoomStatus } from "./app-state";
import type { AppPermissions } from "./create-app-permissions";
export interface AppStateContextProps {
  permissions: AppPermissions;
  conversationMessaging: Pick<
    ConversationMessagingService,
    "sendText" | "sendFile"
  >;
  conversationHistory: Pick<
    ConversationHistoryService,
    "cacheLocalTextBatch"
  >;
  joinRoom: (options?: ClientJoinOptions) => Promise<void>;
  roomConflict: Accessor<boolean>;
  leaveRoom: () => void;
  activeRoomConversationId: Accessor<string | null>;
  roomChatCapabilities: Accessor<
    Readonly<
      Record<
        string,
        "checking" | "supported" | "unsupported"
      >
    >
  >;
  sendRoomText: (text: string) => Promise<void>;
  roomFileCapabilities: AppStateContextProps["roomChatCapabilities"];
  sendRoomFile: (file: FileSource) => Promise<void>;
  requestRoomFile: (
    message: FileTransferMessage,
  ) => Promise<void>;
  requestFile: (
    target: ClientID,
    info: ChunkMetaData,
    resume?: boolean,
  ) => Promise<void>;
  sendText: (
    text: string,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  sendFile: (
    file: FileSource,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  sendClipboard: (
    text: string,
    target: ClientID | ClientID[],
  ) => Promise<void>;
  catalog: Pick<FileCatalogService<PeerSession>, "watch">;
  sharedFiles: Pick<
    SharedFileTransfers,
    "download" | "downloadTask"
  >;
  supportsSharedFiles(session: PeerSession): boolean;
  retryMessage: (message: StoreMessage) => Promise<void>;
  shareFile: (fileId: FileID, target: ClientID) => void;
  resumeFile: (
    fileId: FileID,
    target: ClientID,
  ) => Promise<void>;
  pauseFile: (
    fileId: FileID,
    target: ClientID,
  ) => Promise<void>;
  tasks: TaskService;
  getSpeedTestState: (
    target: ClientID | null,
  ) => SpeedTestState | undefined;
  speedTestState: Accessor<SpeedTestState>;
  speedTestApproval: Accessor<
    SpeedTestApprovalRequest | undefined
  >;
  startSpeedTest: (target: ClientID) => Promise<void>;
  cancelSpeedTest: (target?: ClientID) => void;
  approveSpeedTest: (target: ClientID) => void;
  declineSpeedTest: (target: ClientID) => void;
  localStream: Accessor<MediaStream | null>;
  replaceLocalStream: (stream: MediaStream | null) => void;
  clearLocalStream: () => void;
  roomStatus: RoomStatus;
}

export const AppStateContext = createContext<
  AppStateContextProps | undefined
>(undefined);

export const useAppState = (): AppStateContextProps => {
  const context = useContext(AppStateContext);
  if (!context) {
    throw new Error(
      "useAppState must be used within a AppStateProvider",
    );
  }
  return context;
};
