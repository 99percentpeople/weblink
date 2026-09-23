import { FILE_CONTENT_FEATURE } from "@/libs/domain/protocol/messages";
import type { PeerSession } from "@/libs/domain/session";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import type { RtcService } from "../rtc/rtc-service";

export class FileContentCapabilities {
  private readonly peers = new WeakMap<
    PeerSession,
    { at: number; supported: boolean }
  >();
  private readonly stops: (() => void)[];
  constructor(
    protocol: Pick<WebRtcProtocol, "on">,
    rtc: Pick<RtcService, "onSessionClosed">,
  ) {
    this.stops = [
      protocol.on(
        "client-profile",
        ({ session, message }) => {
          if (
            (this.peers.get(session)?.at ?? -1) >=
            message.createdAt
          )
            return;
          this.peers.set(session, {
            at: message.createdAt,
            supported:
              message.features?.includes(
                FILE_CONTENT_FEATURE,
              ) ?? false,
          });
        },
      ),
      rtc.onSessionClosed((session) => {
        this.peers.delete(session);
      }),
    ];
  }
  supports(session: PeerSession): boolean {
    return this.peers.get(session)?.supported ?? false;
  }
  dispose(): void {
    this.stops.forEach((stop) => stop());
  }
}
