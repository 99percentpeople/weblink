import type { PeerSession } from "@/libs/core/session";
import type { SessionMessage } from "@/libs/core/protocol/messages";
import type {
  RtcAnyMessageHandler,
  RtcProtocolTransport,
  RtcSessionClosedHandler,
} from "@/libs/core/protocol/transport";
import {
  type MessageSendOptions,
  RtcProtocolError,
} from "@/libs/core/protocol/errors";

export class FakeRtcTransport implements RtcProtocolTransport {
  readonly sendCalls: {
    session: PeerSession;
    message: SessionMessage;
    options?: MessageSendOptions;
  }[] = [];
  readonly handlers = new Set<RtcAnyMessageHandler>();
  readonly closedHandlers =
    new Set<RtcSessionClosedHandler>();
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

  onAny(handler: RtcAnyMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  onSessionClosed(
    handler: RtcSessionClosedHandler,
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
