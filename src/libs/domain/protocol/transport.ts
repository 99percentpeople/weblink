import type { MessageSendOptions } from "./errors";
import type {
  ProtocolPeer,
  SessionMessage,
} from "./messages";

export interface ProtocolSession extends ProtocolPeer {}

export type ProtocolMessageContext<
  S extends ProtocolSession = ProtocolSession,
  T extends SessionMessage = SessionMessage,
> = {
  session: S;
  message: T;
};

export type ProtocolAnyMessageHandler<
  S extends ProtocolSession = ProtocolSession,
> = (
  context: ProtocolMessageContext<S>,
) => void | Promise<void>;

export type ProtocolSessionClosedHandler<
  S extends ProtocolSession = ProtocolSession,
> = (session: S) => void;

export interface ProtocolTransport<
  S extends ProtocolSession = ProtocolSession,
> {
  /**
   * Resolve only after the underlying transport accepted the serialized
   * message for sending, never when it was merely queued locally.
   */
  send(
    session: S,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void>;

  onAny(handler: ProtocolAnyMessageHandler<S>): () => void;

  onSessionClosed(
    handler: ProtocolSessionClosedHandler<S>,
  ): () => void;
}

// WebRTC-era aliases retained for current Weblink callers.
export type RtcMessageContext<
  T extends SessionMessage = SessionMessage,
  S extends ProtocolSession = ProtocolSession,
> = ProtocolMessageContext<S, T>;
export type RtcAnyMessageHandler<
  S extends ProtocolSession = ProtocolSession,
> = ProtocolAnyMessageHandler<S>;
export type RtcSessionClosedHandler<
  S extends ProtocolSession = ProtocolSession,
> = ProtocolSessionClosedHandler<S>;
export type RtcProtocolTransport<
  S extends ProtocolSession = ProtocolSession,
> = ProtocolTransport<S>;
