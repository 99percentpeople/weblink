import { snapshotSessionMessage } from "@/libs/core/protocol/validation";
import type { PeerSession } from "@/libs/core/session";
import {
  createSessionMessage,
  isRequestType,
  type MessageMetadata,
  type MessageOf,
  type MessagePayload,
  type NotificationType,
  type RequestResult,
  type RequestType,
} from "@/libs/core/protocol/messages";
import {
  type MessageSendOptions,
  type RequestOptions,
  RtcProtocolError,
} from "@/libs/core/protocol/errors";
import {
  RtcRequestManager,
  type NotificationHandler,
  type RequestHandler,
} from "@/libs/core/protocol/request-manager";
import type { RtcProtocolTransport } from "@/libs/core/protocol/transport";
import { createRtcService } from "./rtc-service";

export * from "@/libs/core/protocol/messages";
export { RtcProtocolError } from "@/libs/core/protocol/errors";
export type { RtcProtocolErrorCode } from "@/libs/core/protocol/errors";
export type { RtcProtocolTransport } from "@/libs/core/protocol/transport";

export type RtcCallOptions<T extends RequestType> =
  RequestOptions &
    MessageMetadata & {
      /** Runs once after reserving the request, before sending. For local tracking. */
      onPrepared?: (message: MessageOf<T>) => void;
    };

/** Typed asynchronous control protocol; file/speed-test streams stay independent. */
export class RtcProtocol {
  private readonly requests: RtcRequestManager;

  constructor(transport: RtcProtocolTransport) {
    this.requests = new RtcRequestManager(transport);
  }

  async call<T extends RequestType>(
    session: PeerSession,
    type: T,
    payload: MessagePayload<T>,
    options: RtcCallOptions<T> = {},
  ): Promise<RequestResult<T>> {
    if (!isRequestType(type))
      throw new RtcProtocolError(
        "invalid-message",
        `Not a request: ${type}`,
      );
    options = { ...options };
    const message = snapshotSessionMessage(
      createSessionMessage(session, type, payload, options),
    );
    const reply = await this.requests.request(
      session,
      message,
      options,
      () => options.onPrepared?.(message),
    );
    return (
      reply.type === "storage" ? reply.data : reply
    ) as RequestResult<T>;
  }

  async notify<T extends NotificationType>(
    session: PeerSession,
    type: T,
    payload: MessagePayload<T>,
    options: MessageSendOptions & MessageMetadata = {},
  ): Promise<void> {
    if (
      ![
        "client-profile",
        "stream-state",
        "read-text",
      ].includes(type)
    )
      throw new RtcProtocolError(
        "invalid-message",
        `Not a notification: ${type}`,
      );
    await this.requests.send(
      session,
      createSessionMessage(session, type, payload, options),
      options,
    );
  }

  handle<T extends RequestType>(
    type: T,
    handler: RequestHandler<T>,
  ): () => void {
    return this.requests.handle(type, handler);
  }

  on<T extends NotificationType>(
    type: T,
    handler: NotificationHandler<T>,
  ): () => void {
    return this.requests.on(type, handler);
  }

  dispose(): void {
    this.requests.dispose();
  }
}

export let rtcProtocol: RtcProtocol;
export function createRtcProtocol(): RtcProtocol {
  return (rtcProtocol ??= new RtcProtocol(
    createRtcService(),
  ));
}
