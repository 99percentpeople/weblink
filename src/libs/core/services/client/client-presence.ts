import {
  createAnonymousPeerProfile,
  RTC_PROFILE_PROTOCOL_VERSION,
} from "@/libs/core/profile";
import type { TransferClient } from "../type";

/**
 * Build the presence record published through signaling.
 * Real display metadata is exchanged later over WebRTC.
 */
export function createClientPresence(
  client: TransferClient,
  resume?: boolean,
): TransferClient {
  const presence: TransferClient = {
    clientId: client.clientId,
    ...createAnonymousPeerProfile(client.clientId),
    createdAt: client.createdAt,
    rtcProfileVersion: RTC_PROFILE_PROTOCOL_VERSION,
  };
  if (resume !== undefined) {
    presence.resume = resume;
  }
  return presence;
}
