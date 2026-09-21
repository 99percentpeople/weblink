import type { PeerSession } from "@/libs/core/session";
import type { ClientID } from "@/libs/core/type";
import type { SessionMessage } from "@/libs/core/protocol/messages";
import type { MessageSendOptions } from "@/libs/core/protocol/errors";
import type {
  RtcAnyMessageHandler,
  RtcProtocolTransport,
  RtcSessionClosedHandler,
} from "@/libs/core/protocol/transport";

export type RtcChannelHandler = (context: {
  session: PeerSession;
  channel: RTCDataChannel;
}) => void | Promise<void>;

/** Session event routing only. Protocol state belongs to RtcProtocol. */
export class RtcService implements RtcProtocolTransport {
  private readonly bindings = new Map<
    ClientID,
    { session: PeerSession; controller: AbortController }
  >();
  private readonly messageHandlers =
    new Set<RtcAnyMessageHandler>();
  private readonly channelHandlers =
    new Set<RtcChannelHandler>();
  private readonly closedHandlers =
    new Set<RtcSessionClosedHandler>();

  bindSession(session: PeerSession): void {
    const key = session.targetClientId;
    if (this.bindings.get(key)?.session === session) return;
    this.unbindSession(key);
    const controller = new AbortController();
    this.bindings.set(key, { session, controller });
    controller.signal.addEventListener(
      "abort",
      () => {
        if (this.bindings.get(key)?.session === session)
          this.bindings.delete(key);
        for (const handler of this.closedHandlers)
          this.runHandler(() => handler(session));
      },
      { once: true },
    );
    session.addEventListener(
      "message",
      (event) => {
        for (const handler of this.messageHandlers)
          this.runHandler(() =>
            handler({ session, message: event.detail }),
          );
      },
      { signal: controller.signal },
    );
    session.addEventListener(
      "channel",
      (event) => {
        for (const handler of this.channelHandlers)
          this.runHandler(() =>
            handler({ session, channel: event.detail }),
          );
      },
      { signal: controller.signal },
    );
    session.addEventListener(
      "statuschange",
      (event) => {
        if (event.detail === "closed") controller.abort();
      },
      { signal: controller.signal },
    );
  }

  unbindSession(clientId: ClientID): void {
    this.bindings.get(clientId)?.controller.abort();
  }

  unbindAllSessions(): void {
    for (const binding of [...this.bindings.values()])
      binding.controller.abort();
  }

  send(
    session: PeerSession,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void> {
    return session.sendMessage(message, options);
  }

  onAny(handler: RtcAnyMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
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

  onChannel(handler: RtcChannelHandler): () => void {
    this.channelHandlers.add(handler);
    return () => {
      this.channelHandlers.delete(handler);
    };
  }

  private runHandler(handler: () => unknown): void {
    try {
      Promise.resolve(handler()).catch((error) =>
        console.error(error),
      );
    } catch (error) {
      console.error(error);
    }
  }
}

export let rtcService: RtcService;
export function createRtcService(): RtcService {
  return (rtcService ??= new RtcService());
}
