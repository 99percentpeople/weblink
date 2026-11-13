import type { PeerSession } from "@/libs/domain/session";
import type { ClientID } from "@/libs/domain/ids";
import { EventBus } from "@weblink/platform/events";
import type {
  ProtocolMessageContext,
  ProtocolSessionCloseOptions,
  ProtocolTransport,
} from "@/libs/domain/protocol/transport";

export interface RtcServiceEventMap {
  message: ProtocolMessageContext<PeerSession>;
  channel: {
    session: PeerSession;
    channel: RTCDataChannel;
  };
  sessionclosed: {
    session: PeerSession;
    options?: ProtocolSessionCloseOptions;
  };
}

/** Session event routing only. The portable protocol owns its request state. */
export class RtcService {
  private readonly bindings = new Map<
    ClientID,
    { session: PeerSession; controller: AbortController }
  >();
  private readonly bus = new EventBus<RtcServiceEventMap>(
    "rtc",
    (error) => console.error(error),
  );
  readonly events = this.bus.events;
  /** Adapt application events to the self-contained protocol contract. */
  readonly transport: ProtocolTransport<PeerSession> = {
    send: (session, message, options) =>
      session.sendMessage(message, options),
    onAny: (handler) =>
      this.events.subscribe("message", handler),
    onSessionClosed: (handler) =>
      this.events.subscribe(
        "sessionclosed",
        ({ session, options }) =>
          options
            ? handler(session, options)
            : handler(session),
      ),
  };

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
        this.bus.emit("sessionclosed", { session });
      },
      { once: true },
    );
    session.events.subscribe(
      "message",
      (message) =>
        this.bus.emit("message", { session, message }),
      { signal: controller.signal },
    );
    session.events.subscribe(
      "channel",
      (channel) =>
        this.bus.emit("channel", { session, channel }),
      { signal: controller.signal },
    );
    session.events.subscribe(
      "accesschange",
      (allowed) => {
        // Cancel work during trust reverification; the session remains reusable.
        if (!allowed)
          this.bus.emit("sessionclosed", {
            session,
            options: { recoverable: true },
          });
      },
      { signal: controller.signal },
    );
    session.events.subscribe(
      "statuschange",
      (status) => {
        if (status === "closed") controller.abort();
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
}

export let rtcService: RtcService;
export function createRtcService(): RtcService {
  return (rtcService ??= new RtcService());
}
