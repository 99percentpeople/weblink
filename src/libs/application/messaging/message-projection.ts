import type {
  FileTransferMessage,
  StoreMessage,
  TextMessage,
} from "@/libs/domain/message";
import type {
  AckMessage,
  ErrorMessage,
  RequestFileMessage,
  SendFileMessage,
  SendTextMessage,
  SessionMessage,
} from "@/libs/domain/protocol/messages";
import { directConversationId } from "@/libs/domain/conversation";

export type TrackedMessage =
  | SendTextMessage
  | SendFileMessage
  | RequestFileMessage;

export type TrackedResponse = AckMessage | ErrorMessage;

function textMessage(
  message: SendTextMessage,
  status: "sending" | "received",
): TextMessage {
  return {
    ...message,
    conversationId: directConversationId(
      message.client,
      message.target,
    ),
    type: "text",
    status,
  };
}

function sentFileMessage(
  message: SendFileMessage,
  status: "sending" | "received",
): FileTransferMessage {
  return {
    ...message,
    conversationId: directConversationId(
      message.client,
      message.target,
    ),
    type: "file",
    status,
  };
}

function requestedFileMessage(
  message: RequestFileMessage,
  status: "sending" | "received",
): FileTransferMessage {
  return {
    id: message.id,
    conversationId: directConversationId(
      message.client,
      message.target,
    ),
    type: "file",
    status,
    fid: message.fid,
    fileName: message.fileName,
    fileSize: message.fileSize,
    mimeType: message.mimeType,
    lastModified: message.lastModified,
    chunkSize: message.chunkSize,
    createdAt: message.createdAt,
    client: message.target,
    target: message.client,
    transferStatus: "init",
  };
}

export function isTrackedMessage(
  message: SessionMessage,
): message is TrackedMessage {
  return (
    message.type === "send-text" ||
    message.type === "send-file" ||
    message.type === "request-file"
  );
}

export function projectOutgoingMessage(
  message: SessionMessage,
): StoreMessage | null {
  switch (message.type) {
    case "send-text":
      return textMessage(message, "sending");
    case "send-file":
      return sentFileMessage(message, "sending");
    case "request-file":
      return requestedFileMessage(message, "sending");
    default:
      return null;
  }
}

export function projectIncomingMessage(
  message: SessionMessage,
): StoreMessage | null {
  switch (message.type) {
    case "send-text":
      return textMessage(message, "received");
    case "send-file":
      return sentFileMessage(message, "received");
    case "request-file":
      return requestedFileMessage(message, "received");
    default:
      return null;
  }
}

export function projectRetry(
  current: StoreMessage,
  message: SessionMessage,
): StoreMessage | null {
  switch (message.type) {
    case "send-text":
      if (current.type !== "text") return null;
      return {
        ...current,
        status: "sending",
        error: undefined,
        data: message.data,
      };
    case "send-file":
      if (current.type !== "file") return null;
      return {
        ...current,
        status: "sending",
        error: undefined,
        fid: message.fid,
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimeType: message.mimeType,
        lastModified: message.lastModified,
        chunkSize: message.chunkSize,
      };
    case "request-file":
      if (current.type !== "file") return null;
      return {
        ...current,
        status: "sending",
        error: undefined,
        fid: message.fid,
        fileName: message.fileName,
        fileSize: message.fileSize,
        mimeType: message.mimeType,
        lastModified: message.lastModified,
        chunkSize: message.chunkSize,
        transferStatus: "init",
      };
    default:
      return null;
  }
}

export function applyTrackedResponse(
  current: StoreMessage,
  message: SessionMessage,
): StoreMessage | null {
  switch (message.type) {
    case "ack":
      return {
        ...current,
        status: "received",
        error: undefined,
      };
    case "error":
      return {
        ...current,
        status: "error",
        error: message.error,
      };
    default:
      return null;
  }
}
