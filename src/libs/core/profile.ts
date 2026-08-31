import type { Client } from "./type";

export const RTC_PROFILE_PROTOCOL_VERSION = 1 as const;
export const MAX_PEER_PROFILE_NAME_LENGTH = 128;
export const MAX_PEER_PROFILE_AVATAR_LENGTH = 256 * 1024;

export type PeerProfile = Pick<Client, "name" | "avatar">;

export interface ClientProfile extends Client {
  roomId: string;
  password: string | null;
  autoJoin: boolean;
  initalJoin: boolean;
}

export function createAnonymousPeerProfile(
  clientId: string,
): PeerProfile {
  const suffix = clientId.replaceAll("-", "").slice(0, 8);
  return {
    name: `Peer-${suffix || "unknown"}`,
    avatar: null,
  };
}

export function normalizePeerProfile(
  value: unknown,
  clientId: string,
): PeerProfile {
  const fallback = createAnonymousPeerProfile(clientId);
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Partial<PeerProfile>;
  const normalizedName =
    typeof candidate.name === "string"
      ? candidate.name
          .trim()
          .slice(0, MAX_PEER_PROFILE_NAME_LENGTH)
      : "";

  let avatar: string | null = null;
  if (
    typeof candidate.avatar === "string" &&
    candidate.avatar.length <=
      MAX_PEER_PROFILE_AVATAR_LENGTH
  ) {
    avatar = candidate.avatar;
  }

  return {
    name: normalizedName || fallback.name,
    avatar,
  };
}
