import type { FileFingerprint } from "./file-fingerprint";
export type MessageID = string;
export type ProtocolPeerID = string;
export type ProtocolFileID = string;
export type ProtocolChunkRange = number | [number, number];

export const P2P_PROFILE_PROTOCOL_VERSION = 1 as const;
export const P2P_ROOM_CHAT_PROTOCOL_VERSION = 1 as const;
export const P2P_ROOM_FILE_PROTOCOL_VERSION = 1 as const;
export const FILE_CONTENT_FEATURE =
  "file-content-v1" as const;
export const SHARED_FILES_FEATURE =
  "shared-files-v1" as const;
export const ROOM_FILE_FEATURE = "room-file-v1" as const;
export const AUDIO_SOURCES_FEATURE =
  "audio-sources-v1" as const;
export const ROOM_CHAT_MAX_TEXT_LENGTH = 64 * 1024;
export const RTC_PROFILE_PROTOCOL_VERSION =
  P2P_PROFILE_PROTOCOL_VERSION;

export type ProtocolPeerProfile = {
  name: string;
  avatar: string | null;
};

export type ProtocolFileMetadata = {
  fingerprint?: FileFingerprint;
  id: ProtocolFileID;
  fileName: string;
  fileSize: number;
  lastModified?: number;
  mimetype?: string;
  chunkSize?: number;
  from?: ProtocolPeerID;
  createdAt?: number;
};

export interface BaseExchangeMessage {
  id: MessageID;
  type: string;
  createdAt: number;
  client: ProtocolPeerID;
  target: ProtocolPeerID;
}

export type SendTextMessage = BaseExchangeMessage & {
  type: "send-text";
  data: string;
};

/** Both peers announce a fresh binding token when their data channel opens. */
export type RoomCapabilitiesMessage =
  BaseExchangeMessage & {
    type: "room-capabilities";
    version: typeof P2P_ROOM_CHAT_PROTOCOL_VERSION;
    roomId: string;
    token: string;
    features?: string[];
  };

/** The envelope target is still a peer; room scope belongs to the payload. */
export type SendRoomTextMessage = BaseExchangeMessage & {
  type: "send-room-text";
  version: typeof P2P_ROOM_CHAT_PROTOCOL_VERSION;
  roomId: string;
  senderToken: string;
  recipientToken: string;
  senderName: string;
  senderAvatar: string | null;
  data: string;
};

/** A durable room offer; binary transfer starts only after an explicit pull. */
export type SendRoomFileMessage = BaseExchangeMessage & {
  type: "send-room-file";
  version: typeof P2P_ROOM_FILE_PROTOCOL_VERSION | 2;
  fingerprint?: FileFingerprint;
  roomId: string;
  senderToken: string;
  recipientToken: string;
  senderName: string;
  senderAvatar: string | null;
  fid: ProtocolFileID;
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
};

/** Each download attempt has its own envelope id, separate from offerId. */
export type RequestRoomFileMessage = BaseExchangeMessage & {
  type: "request-room-file";
  version: typeof P2P_ROOM_FILE_PROTOCOL_VERSION;
  roomId: string;
  senderToken: string;
  recipientToken: string;
  offerId: MessageID;
  fid: ProtocolFileID;
  ranges?: ProtocolChunkRange[];
  resume: boolean;
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
  fid: ProtocolFileID;
  ranges?: ProtocolChunkRange[];
  fileName: string;
  fileSize: number;
  mimeType?: string;
  lastModified?: number;
  chunkSize: number;
  resume: boolean;
};

export type ResumeFileMessage = BaseExchangeMessage & {
  type: "resume-file";
  fid: ProtocolFileID;
};

export type SendFileMessage = BaseExchangeMessage & {
  type: "send-file";
  fingerprint?: FileFingerprint;
  fid: ProtocolFileID;
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

/** Breaking directory protocol: queries and responses are paginated. */
export const P2P_STORAGE_PROTOCOL_VERSION = 3 as const;
export const STORAGE_MAX_PAGE_SIZE = 100;
export const STORAGE_MAX_SEARCH_LENGTH = 256;
export const STORAGE_SORT_FIELDS = [
  "fileName",
  "fileSize",
  "createdAt",
  "lastModified",
  "mimetype",
] as const;
export type StorageSortField =
  (typeof STORAGE_SORT_FIELDS)[number];
export type StorageQuery = {
  /** Zero-based page index; an out-of-range page is clamped by the provider. */
  pageIndex: number;
  pageSize: number;
  /** Case-insensitive filename substring, normalized with NFKC and trimmed. */
  search?: string;
  sort?: { field: StorageSortField; desc: boolean }[];
};
export type StoragePage = {
  items: ProtocolFileMetadata[];
  totalCount: number;
  pageIndex: number;
  pageSize: number;
  sharingEnabled: boolean;
};
export type StorageMessage = BaseExchangeMessage & {
  type: "storage";
  version: typeof P2P_STORAGE_PROTOCOL_VERSION;
  data: StoragePage;
};

export type RequestStorageMessage = BaseExchangeMessage &
  StorageQuery & {
    type: "request-storage";
    version: typeof P2P_STORAGE_PROTOCOL_VERSION;
  };

/** Invalidation only: deliberately carries no file data or change details. */
export type StorageChangedMessage = BaseExchangeMessage & {
  type: "storage-changed";
};

export type StreamVideoSource = {
  mid: string;
  kind: "camera" | "screen";
};

export type StreamAudioSource =
  | { mid: string; kind: "microphone" }
  | { mid: string; kind: "screen"; videoMid: string };

export type StreamStateMessage = BaseExchangeMessage & {
  type: "stream-state";
  mode: "placeholder" | "media";
  /** Complete negotiated video-source snapshot, keyed by RTP MID. */
  videoSources: StreamVideoSource[];
  /** Sent only to peers advertising AUDIO_SOURCES_FEATURE. */
  audioSources?: StreamAudioSource[];
};

export type ClientProfileMessage = BaseExchangeMessage & {
  type: "client-profile";
  version: typeof P2P_PROFILE_PROTOCOL_VERSION;
  profile: ProtocolPeerProfile;
  features?: string[];
};

export type FileOfferResult = {
  fid: string;
  disposition: "have" | "need" | "deferred";
  reason?: "user" | "local-job";
};
export type FileOfferResultMessage = BaseExchangeMessage &
  FileOfferResult & {
    type: "file-offer-result";
    version: 1;
  };
export type FileContentReadyMessage =
  BaseExchangeMessage & {
    type: "file-content-ready";
    version: 1;
    offerId: string;
    fid: string;
    fingerprint: FileFingerprint;
    roomId?: string;
    senderToken?: string;
    recipientToken?: string;
  };

export type RequestSharedFileMessage =
  BaseExchangeMessage & {
    type: "request-shared-file";
    version: 1;
    fid: string;
    transferId: string;
    fingerprint: FileFingerprint;
    chunkSize: number;
    ranges?: ProtocolChunkRange[];
    /** Authorization-only check for already verified local content. */
    have: boolean;
  };

export type SessionMessage =
  | RequestSharedFileMessage
  | FileOfferResultMessage
  | FileContentReadyMessage
  | SendTextMessage
  | RoomCapabilitiesMessage
  | SendRoomTextMessage
  | SendRoomFileMessage
  | RequestRoomFileMessage
  | AckMessage
  | ReadTextMessage
  | RequestFileMessage
  | SendFileMessage
  | SendClipboardMessage
  | ErrorMessage
  | StorageMessage
  | RequestStorageMessage
  | StorageChangedMessage
  | ResumeFileMessage
  | StreamStateMessage
  | ClientProfileMessage;

type MessageFactoryBaseInput = {
  id?: MessageID;
  createdAt?: number;
  client: ProtocolPeerID;
  target: ProtocolPeerID;
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

/** Wire behavior, shared by every client implementation. */
export const requestSpec = {
  "send-text": { ack: "receive" },
  "room-capabilities": { ack: "receive" },
  "send-room-text": { ack: "receive" },
  "send-room-file": { ack: "receive" },
  "request-room-file": { ack: "send" },
  "send-clipboard": { ack: "receive" },
  "send-file": { ack: "receive" },
  "file-content-ready": { ack: "receive" },
  "request-file": { ack: "send" },
  "request-shared-file": { ack: "send" },
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
  | "read-text"
  | "storage-changed";

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
    ? StoragePage
    : T extends "send-file" | "send-room-file"
      ? AckMessage | FileOfferResultMessage
      : AckMessage;

export type HandlerResult<T extends RequestType> =
  T extends "request-storage"
    ? StoragePage
    : T extends "send-file" | "send-room-file"
      ? FileOfferResult | void
      : void;

export type ProtocolPeer = {
  clientId: ProtocolPeerID;
  targetClientId: ProtocolPeerID;
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
    ...(type === "file-offer-result" ||
    type === "file-content-ready" ||
    type === "request-shared-file"
      ? { version: 1 }
      : type === "send-room-file" &&
          "fingerprint" in payload &&
          payload.fingerprint
        ? { version: 2 }
        : type === "client-profile"
          ? { version: P2P_PROFILE_PROTOCOL_VERSION }
          : type === "room-capabilities" ||
              type === "send-room-text"
            ? { version: P2P_ROOM_CHAT_PROTOCOL_VERSION }
            : type === "send-room-file" ||
                type === "request-room-file"
              ? { version: P2P_ROOM_FILE_PROTOCOL_VERSION }
              : type === "request-storage" ||
                  type === "storage"
                ? { version: P2P_STORAGE_PROTOCOL_VERSION }
                : {}),
  } as MessageOf<T>;
}

export function isRequestType(
  type: string,
): type is RequestType {
  return Object.hasOwn(requestSpec, type);
}
