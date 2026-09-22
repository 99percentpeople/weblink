import {
  createSessionMessage,
  isRequestType,
  type MessageMetadata,
  type MessageOf,
  type MessagePayload,
  type NotificationType,
  type RequestResult,
  type RequestType,
} from "./messages";
import {
  type MessageSendOptions,
  type RequestOptions,
  P2PProtocolError,
} from "./errors";
import {
  P2PRequestManager,
  type NotificationHandler,
  type RequestHandler,
} from "./request-manager";
import { snapshotSessionMessage } from "./validation";
import type {
  ProtocolSession,
  ProtocolTransport,
} from "./transport";

export type ProtocolCallOptions<T extends RequestType> =
  RequestOptions &
    MessageMetadata & {
      /** Runs once after reserving the request, before sending. */
      onPrepared?: (message: MessageOf<T>) => void;
    };

/**
 * Transport-agnostic typed P2P control protocol.
 *
 * Any client can use this state machine by providing a ProtocolTransport and
 * session handles containing only clientId/targetClientId identity.
 */
export class P2PProtocol<
  S extends ProtocolSession = ProtocolSession,
> {
  private readonly requests: P2PRequestManager<S>;

  constructor(transport: ProtocolTransport<S>) {
    this.requests = new P2PRequestManager(transport);
  }

  async call<T extends RequestType>(
    session: S,
    type: T,
    payload: MessagePayload<T>,
    options: ProtocolCallOptions<T> = {},
  ): Promise<RequestResult<T>> {
    if (!isRequestType(type)) {
      throw new P2PProtocolError(
        "invalid-message",
        `Not a request: ${type}`,
      );
    }

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
    session: S,
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
    ) {
      throw new P2PProtocolError(
        "invalid-message",
        `Not a notification: ${type}`,
      );
    }

    await this.requests.send(
      session,
      createSessionMessage(session, type, payload, options),
      options,
    );
  }

  handle<T extends RequestType>(
    type: T,
    handler: RequestHandler<T, S>,
  ): () => void {
    return this.requests.handle(type, handler);
  }

  on<T extends NotificationType>(
    type: T,
    handler: NotificationHandler<T, S>,
  ): () => void {
    return this.requests.on(type, handler);
  }

  dispose(): void {
    this.requests.dispose();
  }
}

// Current Weblink naming compatibility.
export { P2PProtocol as RtcProtocol };
export type RtcCallOptions<T extends RequestType> =
  ProtocolCallOptions<T>;
