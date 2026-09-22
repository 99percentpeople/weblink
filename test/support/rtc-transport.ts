import type { PeerSession } from "@/libs/domain/session";
import type { SessionMessage } from "@/libs/domain/protocol/messages";
import type {
  RtcAnyMessageHandler,
  RtcProtocolTransport,
  RtcSessionClosedHandler,
} from "@/libs/domain/protocol/transport";
import {
  type MessageSendOptions,
  RtcProtocolError,
} from "@/libs/domain/protocol/errors";

export class FakeRtcTransport implements RtcProtocolTransport<PeerSession> {
  readonly sendCalls: {
    session: PeerSession;
    message: SessionMessage;
    options?: MessageSendOptions;
  }[] = [];
  readonly handlers = new Set<
    RtcAnyMessageHandler<PeerSession>
  >();
  readonly closedHandlers = new Set<
    RtcSessionClosedHandler<PeerSession>
  >();
  sendImpl?: (
    session: PeerSession,
    message: SessionMessage,
    options?: MessageSendOptions,
  ) => void | Promise<void>;

  async send(
    session: PeerSession,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void> {
    if (options?.signal?.aborted)
      throw new RtcProtocolError("aborted");
    this.sendCalls.push({ session, message, options });
    await this.sendImpl?.(session, message, options);
  }

  onAny(
    handler: RtcAnyMessageHandler<PeerSession>,
  ): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onSessionClosed(
    handler: RtcSessionClosedHandler<PeerSession>,
  ): () => void {
    this.closedHandlers.add(handler);
    return () => {
      this.closedHandlers.delete(handler);
    };
  }

  async emit(
    session: PeerSession,
    message: SessionMessage,
  ): Promise<void> {
    await Promise.all(
      [...this.handlers].map((handler) =>
        handler({ session, message }),
      ),
    );
  }

  close(session: PeerSession): void {
    for (const handler of this.closedHandlers)
      handler(session);
  }
}

export const makeSession = (
  clientId = "a",
  targetClientId = "b",
) => ({ clientId, targetClientId }) as PeerSession;

export async function flushRtc(): Promise<void> {
  for (let index = 0; index < 20; index++)
    await Promise.resolve();
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
