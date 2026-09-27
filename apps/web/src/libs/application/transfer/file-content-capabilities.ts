import { createSignal } from "solid-js";
import {
  FILE_CONTENT_FEATURE,
  SHARED_FILES_FEATURE,
} from "@/libs/domain/protocol/messages";
import type { PeerSession } from "@/libs/domain/session";
import type { WebRtcProtocol } from "../rtc/rtc-protocol";
import type { RtcService } from "../rtc/rtc-service";

export class FileContentCapabilities {
  private readonly revision = createSignal(0);
  private readonly peers = new WeakMap<
    PeerSession,
    { at: number; supported: boolean; shared: boolean }
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
            shared:
              message.features?.includes(
                SHARED_FILES_FEATURE,
              ) ?? false,
            supported:
              message.features?.includes(
                FILE_CONTENT_FEATURE,
              ) ?? false,
          });
          this.revision[1]((value) => value + 1);
        },
      ),
      rtc.onSessionClosed((session) => {
        this.peers.delete(session);
        this.revision[1]((value) => value + 1);
      }),
    ];
  }
  supports(session: PeerSession): boolean {
    return this.peers.get(session)?.supported ?? false;
  }
  supportsShared(session: PeerSession): boolean {
    this.revision[0]();
    return this.peers.get(session)?.shared ?? false;
  }
  dispose(): void {
    this.stops.forEach((stop) => stop());
  }
}
