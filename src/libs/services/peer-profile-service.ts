import {
  normalizePeerProfile,
  RTC_PROFILE_PROTOCOL_VERSION,
} from "@/libs/core/profile";
import type { PeerSession } from "@/libs/core/session";
import type { Client, ClientID } from "@/libs/core/type";
import {
  protocolMessageFactory,
  type RtcProtocol,
} from "@/libs/services/rtc-protocol";

export interface PeerProfileServiceOptions {
  getLocalClient: () => Client;
  onRemoteClient: (client: Client) => void;
}

type ProfileProtocol = Pick<RtcProtocol, "on" | "send">;

type SessionBinding = {
  session: PeerSession;
  controller: AbortController;
};

/**
 * Exchanges display metadata only after the WebRTC message
 * channel is ready. Signaling carries an anonymous placeholder.
 */
export class PeerProfileService {
  private readonly bindings = new Map<
    ClientID,
    SessionBinding
  >();
  private readonly lastReceivedAt = new Map<
    ClientID,
    number
  >();
  private readonly stopListening: () => void;
  private lastSentAt = 0;

  constructor(
    private readonly protocol: ProfileProtocol,
    private readonly options: PeerProfileServiceOptions,
  ) {
    this.stopListening = this.protocol.on(
      "client-profile",
      ({ session, message }) => {
        if (
          this.bindings.get(session.targetClientId)
            ?.session !== session ||
          message.version !==
            RTC_PROFILE_PROTOCOL_VERSION ||
          message.client !== session.targetClientId ||
          message.target !== session.clientId
        ) {
          return;
        }

        const previous =
          this.lastReceivedAt.get(session.targetClientId) ??
          0;
        if (message.createdAt <= previous) return;

        const profile = normalizePeerProfile(
          message.profile,
          session.targetClientId,
        );
        this.lastReceivedAt.set(
          session.targetClientId,
          message.createdAt,
        );
        this.options.onRemoteClient({
          clientId: session.targetClientId,
          ...profile,
        });
      },
    );
  }

  bindSession(session: PeerSession) {
    const clientId = session.targetClientId;
    const existing = this.bindings.get(clientId);
    if (existing?.session === session) return;
    this.unbindSession(clientId);

    const controller = new AbortController();
    this.bindings.set(clientId, { session, controller });

    session.addEventListener(
      "messagechannelchange",
      (event) => {
        if (event.detail !== "ready") return;
        this.sendProfile(session);
      },
      { signal: controller.signal },
    );
    session.addEventListener(
      "statuschange",
      (event) => {
        if (event.detail !== "closed") return;
        this.unbindSession(clientId);
      },
      { signal: controller.signal },
    );

    if (session.isMessageChannelReady) {
      this.sendProfile(session);
    }
  }

  unbindSession(clientId: ClientID) {
    this.bindings.get(clientId)?.controller.abort();
    this.bindings.delete(clientId);
    this.lastReceivedAt.delete(clientId);
  }

  unbindAllSessions() {
    for (const binding of this.bindings.values()) {
      binding.controller.abort();
    }
    this.bindings.clear();
    this.lastReceivedAt.clear();
  }

  broadcast() {
    for (const { session } of this.bindings.values()) {
      if (!session.isMessageChannelReady) continue;
      this.sendProfile(session);
    }
  }

  dispose() {
    this.stopListening();
    this.unbindAllSessions();
  }

  private sendProfile(session: PeerSession) {
    const localClient = this.options.getLocalClient();
    const profile = normalizePeerProfile(
      localClient,
      session.clientId,
    );
    const createdAt = Math.max(
      Date.now(),
      this.lastSentAt + 1,
    );
    this.lastSentAt = createdAt;

    try {
      this.protocol.send(
        session,
        protocolMessageFactory.clientProfile({
          client: session.clientId,
          target: session.targetClientId,
          createdAt,
          profile,
        }),
      );
    } catch (error) {
      console.warn(
        "[PeerProfileService] failed to send profile",
        error,
      );
    }
  }
}
