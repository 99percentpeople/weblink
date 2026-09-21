import type { PeerSession } from "../session";
import type { SessionMessage } from "./messages";
import type { MessageSendOptions } from "./errors";

export type RtcMessageContext<
  T extends SessionMessage = SessionMessage,
> = {
  session: PeerSession;
  message: T;
};
export type RtcAnyMessageHandler = (
  context: RtcMessageContext,
) => void | Promise<void>;
export type RtcSessionClosedHandler = (
  session: PeerSession,
) => void;

export interface RtcProtocolTransport {
  /** Resolve only after the actual DataChannel.send(), never on queue insertion. */
  send(
    session: PeerSession,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void>;
  onAny(handler: RtcAnyMessageHandler): () => void;
  onSessionClosed(
    handler: RtcSessionClosedHandler,
  ): () => void;
}
