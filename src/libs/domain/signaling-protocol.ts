export const SIGNALING_PROTOCOL_VERSION = 2;

export const SIGNALING_MAX_CLIENT_ID_LENGTH = 128;
export const SIGNALING_MAX_ROOM_ID_LENGTH = 256;
export const SIGNALING_MAX_PASSWORD_HASH_LENGTH = 1024;
export const SIGNALING_MAX_MESSAGE_BYTES = 1024 * 1024;
export const SIGNALING_MAX_CACHED_SIGNALS = 256;

export interface SignalingEnvelope<T = unknown> {
  type: string;
  data: T;
}

export interface SignalingClientPresence {
  clientId: string;
  createdAt: number;
  rtcProfileVersion?: number;
  resume?: boolean;
}

export interface SignalingPeerMessage extends SignalingEnvelope {
  sessionId?: string;
  clientId: string;
  targetClientId: string;
}

export interface SignalingPeerOnline {
  clientId: string;
  connectionId: string;
}

export function parseSignalingPeerOnline(
  value: unknown,
): SignalingPeerOnline | null {
  if (!isRecord(value)) return null;
  const clientId = normalizeClientId(value.clientId);
  const connectionId = normalizeClientId(
    value.connectionId,
  );
  if (!clientId || !connectionId) return null;
  return { clientId, connectionId };
}

export interface SignalingJoinAcknowledgement {
  protocolVersion: number;
  resumed: boolean;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizeClientId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const clientId = value.trim();
  if (
    !clientId ||
    clientId.length > SIGNALING_MAX_CLIENT_ID_LENGTH
  ) {
    return null;
  }
  return clientId;
}

export function parseSignalingEnvelope(
  raw: string,
): SignalingEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Invalid signaling message JSON");
  }

  if (!isRecord(value) || typeof value.type !== "string") {
    throw new Error("Invalid signaling message");
  }

  return {
    type: value.type,
    data: value.data,
  };
}

export function encodeSignalingEnvelope(
  signal: SignalingEnvelope,
): string {
  return JSON.stringify(signal);
}

export function parseSignalingClientPresence(
  value: unknown,
): SignalingClientPresence | null {
  if (!isRecord(value)) return null;

  const clientId = normalizeClientId(value.clientId);
  if (
    !clientId ||
    typeof value.createdAt !== "number" ||
    !Number.isFinite(value.createdAt)
  ) {
    return null;
  }

  const rtcProfileVersion =
    typeof value.rtcProfileVersion === "number" &&
    Number.isFinite(value.rtcProfileVersion)
      ? value.rtcProfileVersion
      : undefined;

  return {
    clientId,
    createdAt: value.createdAt,
    rtcProfileVersion,
    resume: value.resume === true ? true : undefined,
  };
}

export function parseSignalingPeerMessage(
  value: unknown,
): SignalingPeerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }

  const clientId = normalizeClientId(value.clientId);
  const targetClientId = normalizeClientId(
    value.targetClientId,
  );
  if (!clientId || !targetClientId) return null;

  return {
    type: value.type,
    data: value.data,
    clientId,
    targetClientId,
    sessionId:
      typeof value.sessionId === "string"
        ? value.sessionId
        : undefined,
  };
}

export function isSignalingJoinAcknowledgement(
  value: unknown,
  minimumVersion = SIGNALING_PROTOCOL_VERSION,
): value is SignalingJoinAcknowledgement {
  if (!isRecord(value)) return false;

  return (
    typeof value.protocolVersion === "number" &&
    Number.isFinite(value.protocolVersion) &&
    value.protocolVersion >= minimumVersion &&
    typeof value.resumed === "boolean"
  );
}

export function encodedSignalingMessageSize(
  message: string,
): number {
  return new TextEncoder().encode(message).byteLength;
}
