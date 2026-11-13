import type { PeerSession } from "@/libs/domain/session";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { createRtcService } from "./rtc-service";

export type WebRtcProtocol = P2PProtocol<PeerSession>;

export let rtcProtocol: WebRtcProtocol;

export function createRtcProtocol(): WebRtcProtocol {
  return (rtcProtocol ??= new P2PProtocol<PeerSession>(
    createRtcService().transport,
  ));
}
