import type { ChunkMetaData } from "@/libs/cache";
import type { PeerSession } from "@/libs/core/session";
import type { ClientID, FileID } from "@/libs/core/type";
import {
  RTC_PROFILE_PROTOCOL_VERSION,
  type PeerProfile,
} from "@/libs/core/profile";
import type { ChunkRange } from "@/libs/utils/range";
import {
  createRtcService,
  RtcMessageStateMachine,
  type RtcMessageContext,
  type RtcMessageHandler,
  type RtcServiceRequestError,
  type RtcServiceRequestErrorCode,
  type RtcServiceRequestHandlerOptions,
  type RtcServiceRequestOptions,
  type RtcServiceRequestResult,
  type RtcServiceTransport,
} from "@/libs/services/rtc-service";

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

/**
 * Factory helpers that keep app-protocol messages in one place.
 * App state should build protocol payloads from here instead of
 * constructing raw objects in business logic.
 */
export const protocolMessageFactory = {
  sendText: (
    input: MessageFactoryBaseInput & {
      data: string;
    },
  ): SendTextMessage => ({
    ...createMessageBase(input),
    type: "send-text",
    data: input.data,
  }),
  ack: (
    input: Omit<MessageFactoryBaseInput, "id"> & {
      id: MessageID;
      mode: AckMessage["mode"];
    },
  ): AckMessage => ({
    ...createMessageBase(input),
    type: "ack",
    mode: input.mode,
  }),
  readText: (
    input: Omit<MessageFactoryBaseInput, "id"> & {
      id: MessageID;
    },
  ): ReadTextMessage => ({
    ...createMessageBase(input),
    type: "read-text",
  }),
  requestFile: (
    input: MessageFactoryBaseInput & {
      fid: FileID;
      ranges?: ChunkRange[];
      fileName: string;
      fileSize: number;
      mimeType?: string;
      lastModified?: number;
      chunkSize: number;
      resume: boolean;
    },
  ): RequestFileMessage => ({
    ...createMessageBase(input),
    type: "request-file",
    fid: input.fid,
    ranges: input.ranges,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    lastModified: input.lastModified,
    chunkSize: input.chunkSize,
    resume: input.resume,
  }),
  resumeFile: (
    input: MessageFactoryBaseInput & {
      fid: FileID;
    },
  ): ResumeFileMessage => ({
    ...createMessageBase(input),
    type: "resume-file",
    fid: input.fid,
  }),
  sendFile: (
    input: MessageFactoryBaseInput & {
      fid: FileID;
      fileName: string;
      fileSize: number;
      mimeType?: string;
      lastModified?: number;
      chunkSize: number;
    },
  ): SendFileMessage => ({
    ...createMessageBase(input),
    type: "send-file",
    fid: input.fid,
    fileName: input.fileName,
    fileSize: input.fileSize,
    mimeType: input.mimeType,
    lastModified: input.lastModified,
    chunkSize: input.chunkSize,
  }),
  sendClipboard: (
    input: MessageFactoryBaseInput & {
      data: string;
    },
  ): SendClipboardMessage => ({
    ...createMessageBase(input),
    type: "send-clipboard",
    data: input.data,
  }),
  error: (
    input: Omit<MessageFactoryBaseInput, "id"> & {
      id: MessageID;
      error: string;
      data?: unknown;
    },
  ): ErrorMessage => ({
    ...createMessageBase(input),
    type: "error",
    error: input.error,
    data: input.data,
  }),
  storage: (
    input: MessageFactoryBaseInput & {
      data: ChunkMetaData[];
    },
  ): StorageMessage => ({
    ...createMessageBase(input),
    type: "storage",
    data: input.data,
  }),
  requestStorage: (
    input: MessageFactoryBaseInput,
  ): RequestStorageMessage => ({
    ...createMessageBase(input),
    type: "request-storage",
  }),
  streamState: (
    input: MessageFactoryBaseInput & {
      mode: StreamStateMessage["mode"];
    },
  ): StreamStateMessage => ({
    ...createMessageBase(input),
    type: "stream-state",
    mode: input.mode,
  }),
  clientProfile: (
    input: MessageFactoryBaseInput & {
      profile: PeerProfile;
    },
  ): ClientProfileMessage => ({
    ...createMessageBase(input),
    type: "client-profile",
    version: RTC_PROFILE_PROTOCOL_VERSION,
    profile: input.profile,
  }),
} as const;

export type RtcProtocolMessageContext<
  T extends SessionMessage = SessionMessage,
> = RtcMessageContext<T>;

export type RtcProtocolMessageHandler<
  T extends SessionMessage["type"],
> = RtcMessageHandler<T>;

export type RtcProtocolRequestOptions =
  RtcServiceRequestOptions;

export type RtcProtocolRequestHandlerOptions =
  RtcServiceRequestHandlerOptions;

export type RtcProtocolTransport = RtcServiceTransport;

export type RtcProtocolRequestErrorCode =
  RtcServiceRequestErrorCode;

export type RtcProtocolRequestError =
  RtcServiceRequestError;

export type RtcProtocolRequestResult =
  RtcServiceRequestResult;

export class RtcProtocol {
  private readonly stateMachine: RtcMessageStateMachine;

  constructor(transport: RtcProtocolTransport) {
    this.stateMachine = new RtcMessageStateMachine(
      transport,
    );
  }

  send(session: PeerSession, message: SessionMessage) {
    this.stateMachine.send(session, message);
  }

  request(
    session: PeerSession,
    message: SessionMessage,
    options: RtcProtocolRequestOptions = {},
  ) {
    return this.stateMachine.request(
      session,
      message,
      options,
    );
  }

  async requestWithResult(
    session: PeerSession,
    message: SessionMessage,
    options: RtcProtocolRequestOptions = {},
  ): Promise<RtcProtocolRequestResult> {
    return this.stateMachine.requestWithResult(
      session,
      message,
      options,
    );
  }

  on<T extends SessionMessage["type"]>(
    type: T,
    handler: RtcProtocolMessageHandler<T>,
  ) {
    return this.stateMachine.on(type, handler);
  }

  onRequest<T extends SessionMessage["type"]>(
    type: T,
    handler: RtcProtocolMessageHandler<T>,
    options: RtcProtocolRequestHandlerOptions,
  ) {
    return this.stateMachine.onRequest(
      type,
      handler,
      options,
    );
  }
}

export let rtcProtocol: RtcProtocol;

export function createRtcProtocol() {
  if (!rtcProtocol) {
    rtcProtocol = new RtcProtocol(createRtcService());
  }
  return rtcProtocol;
}
