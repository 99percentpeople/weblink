import type { ChunkMetaData } from "@/libs/cache";
import type { ClientID, FileID } from "../ids";
import {
  RTC_PROFILE_PROTOCOL_VERSION,
  type PeerProfile,
} from "../profile";
import type { ChunkRange } from "@/libs/utils/range";

export type MessageID = string;

export interface BaseExchangeMessage {
  id: MessageID;
  type: string;
  createdAt: number;
  client: ClientID;
  target: ClientID;
  status?: "sending" | "received" | "error";
}

export type SendTextMessage = BaseExchangeMessage & {
  type: "send-text";
  data: string;
};

export type AckMessage = BaseExchangeMessage & {
  type: "ack";
  mode: "send" | "receive";
  id: MessageID;
};

export type ReadTextMessage = BaseExchangeMessage & {
  type: "read-text";
  id: MessageID;
};

export type RequestFileMessage = BaseExchangeMessage & {
  type: "request-file";
  fid: FileID;
  ranges?: ChunkRange[];
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
  resume: boolean;
};

export type ResumeFileMessage = BaseExchangeMessage & {
  type: "resume-file";
  fid: FileID;
};

export type SendFileMessage = BaseExchangeMessage & {
  type: "send-file";
  fid: FileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
};

export type SendClipboardMessage = BaseExchangeMessage & {
  type: "send-clipboard";
  data: string;
};

export type ErrorMessage = BaseExchangeMessage & {
  type: "error";
  error: string;
  data?: unknown;
};

export type StorageMessage = BaseExchangeMessage & {
  type: "storage";
  data: ChunkMetaData[];
};

export type RequestStorageMessage = BaseExchangeMessage & {
  type: "request-storage";
};

export type StreamStateMessage = BaseExchangeMessage & {
  type: "stream-state";
  mode: "placeholder" | "media";
};

export type ClientProfileMessage = BaseExchangeMessage & {
  type: "client-profile";
  version: typeof RTC_PROFILE_PROTOCOL_VERSION;
  profile: PeerProfile;
};

export type SessionMessage =
  | SendTextMessage
  | AckMessage
  | ReadTextMessage
  | RequestFileMessage
  | SendFileMessage
  | SendClipboardMessage
  | ErrorMessage
  | StorageMessage
  | RequestStorageMessage
  | ResumeFileMessage
  | StreamStateMessage
  | ClientProfileMessage;

type MessageFactoryBaseInput = {
  id?: MessageID;
  createdAt?: number;
  client: ClientID;
  target: ClientID;
};

const createMessageId = () => {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
};

const createMessageBase = (
  input: MessageFactoryBaseInput,
) => ({
  id: input.id ?? createMessageId(),
  createdAt: input.createdAt ?? Date.now(),
  client: input.client,
  target: input.target,
});

/** Wire behavior, shared by callers and request handlers. */
export const requestSpec = {
  "send-text": { ack: "receive" },
  "send-clipboard": { ack: "receive" },
  "send-file": { ack: "receive" },
  "request-file": { ack: "send" },
  "resume-file": { ack: "receive" },
  "request-storage": { ack: "receive" },
} as const satisfies Partial<
  Record<
    SessionMessage["type"],
    { ack: AckMessage["mode"] }
  >
>;

export type RequestType = keyof typeof requestSpec;
export type NotificationType =
  | "client-profile"
  | "stream-state"
  | "read-text";
export type MessageOf<T extends SessionMessage["type"]> =
  Extract<SessionMessage, { type: T }>;
export type MessagePayload<
  T extends SessionMessage["type"],
> = Omit<
  MessageOf<T>,
  keyof BaseExchangeMessage | "version"
>;
export type MessageMetadata = {
  id?: MessageID;
  createdAt?: number;
};
export type RequestResult<T extends RequestType> =
  T extends "request-storage"
    ? ChunkMetaData[]
    : AckMessage;
export type HandlerResult<T extends RequestType> =
  T extends "request-storage" ? ChunkMetaData[] : void;
export type ProtocolPeer = {
  clientId: ClientID;
  targetClientId: ClientID;
};

export function createSessionMessage<
  T extends SessionMessage["type"],
>(
  peer: ProtocolPeer,
  type: T,
  payload: MessagePayload<T>,
  metadata: MessageMetadata = {},
): MessageOf<T> {
  return {
    ...payload,
    ...createMessageBase({
      ...metadata,
      client: peer.clientId,
      target: peer.targetClientId,
    }),
    type,
    ...(type === "client-profile"
      ? { version: RTC_PROFILE_PROTOCOL_VERSION }
      : {}),
  } as MessageOf<T>;
}

export function isRequestType(
  type: string,
): type is RequestType {
  return Object.hasOwn(requestSpec, type);
}
