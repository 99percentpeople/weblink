import type { PeerSession } from "@/libs/domain/session";
import { P2PProtocol } from "@/libs/domain/protocol/protocol";
import { createRtcService } from "./rtc-service";

export * from "@/libs/domain/protocol/messages";
export {
  P2PProtocol,
  P2PProtocol as RtcProtocol,
} from "@/libs/domain/protocol/protocol";
export { RtcProtocolError } from "@/libs/domain/protocol/errors";
export type {
  RtcProtocolErrorCode,
  MessageSendOptions,
  RequestOptions,
} from "@/libs/domain/protocol/errors";
export type {
  ProtocolSession,
  ProtocolTransport,
  RtcProtocolTransport,
} from "@/libs/domain/protocol/transport";
export type {
  ProtocolCallOptions,
  RtcCallOptions,
} from "@/libs/domain/protocol/protocol";

export type WebRtcProtocol = P2PProtocol<PeerSession>;

export let rtcProtocol: WebRtcProtocol;

export function createRtcProtocol(): WebRtcProtocol {
  return (rtcProtocol ??= new P2PProtocol<PeerSession>(
    createRtcService(),
  ));
}
