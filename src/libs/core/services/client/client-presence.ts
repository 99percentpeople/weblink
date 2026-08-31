import {
  createAnonymousPeerProfile,
  RTC_PROFILE_PROTOCOL_VERSION,
} from "@/libs/core/profile";
import type {
  ClientPresence,
  TransferClient,
} from "../type";

/**
 * Build the presence record published through signaling.
 * Real display metadata is exchanged later over WebRTC.
 */
export function createClientPresence(
  client: TransferClient,
  resume?: boolean,
): ClientPresence {
  const presence: ClientPresence = {
    clientId: client.clientId,
    createdAt: client.createdAt,
    rtcProfileVersion: RTC_PROFILE_PROTOCOL_VERSION,
  };
  if (resume !== undefined) {
    presence.resume = resume;
  }
  return presence;
}

export function hydrateClientPresence(
  presence: ClientPresence,
): TransferClient {
  return {
    clientId: presence.clientId,
    createdAt: presence.createdAt,
    rtcProfileVersion: presence.rtcProfileVersion,
    resume: presence.resume,
    ...createAnonymousPeerProfile(presence.clientId),
  };
}
