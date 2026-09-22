import type {
  ProtocolPeer,
  SessionMessage,
} from "./messages";
import { P2PProtocolError } from "./errors";

const record = (
  value: unknown,
): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === "string";
const id = (value: unknown): value is string =>
  text(value) && value.length > 0 && value.length <= 512;
const integer = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const timestamp = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0;
const optional = (
  value: unknown,
  check: (value: unknown) => boolean,
) => value === undefined || check(value);
const chunkSize = (value: unknown): value is number =>
  integer(value) && value > 0;

function fileMetadata(
  value: Record<string, unknown>,
  storage: boolean,
): boolean {
  return (
    id(storage ? value.id : value.fid) &&
    text(value.fileName) &&
    integer(value.fileSize) &&
    optional(value.lastModified, timestamp) &&
    optional(
      storage ? value.mimetype : value.mimeType,
      text,
    ) &&
    (storage
      ? optional(value.chunkSize, chunkSize)
      : chunkSize(value.chunkSize))
  );
}

function ranges(value: unknown, total: number): boolean {
  if (!Array.isArray(value)) return false;
  return value.every((range) =>
    integer(range)
      ? range < total
      : Array.isArray(range) &&
        range.length === 2 &&
        integer(range[0]) &&
        integer(range[1]) &&
        range[0] <= range[1] &&
        range[1] < total,
  );
}

/** Validate network input before trusting TypeScript's discriminated union. */
export function validateSessionMessage(
  value: unknown,
): SessionMessage {
  const fail = (): never => {
    throw new P2PProtocolError(
      "invalid-message",
      "Invalid P2P protocol message",
    );
  };
  if (
    !record(value) ||
    !id(value.id) ||
    !id(value.client) ||
    !id(value.target) ||
    !timestamp(value.createdAt)
  )
    return fail();
  let valid = false;
  switch (value.type) {
    case "send-text":
    case "send-clipboard":
      valid = text(value.data);
      break;
    case "ack":
      valid =
        value.mode === "send" || value.mode === "receive";
      break;
    case "error":
      valid = text(value.error);
      break;
    case "read-text":
    case "request-storage":
      valid = true;
      break;
    case "resume-file":
      valid = id(value.fid);
      break;
    case "send-file":
      valid = fileMetadata(value, false);
      break;
    case "request-file":
      valid =
        fileMetadata(value, false) &&
        typeof value.resume === "boolean" &&
        optional(value.ranges, (items) =>
          ranges(
            items,
            Math.ceil(
              (value.fileSize as number) /
                (value.chunkSize as number),
            ),
          ),
        );
      break;
    case "storage":
      valid =
        Array.isArray(value.data) &&
        value.data.every(
          (item) =>
            record(item) &&
            fileMetadata(item, true) &&
            optional(item.createdAt, timestamp) &&
            optional(item.from, id),
        );
      break;
    case "stream-state":
      valid =
        value.mode === "placeholder" ||
        value.mode === "media";
      break;
    case "client-profile":
      valid =
        integer(value.version) &&
        record(value.profile) &&
        text(value.profile.name) &&
        (value.profile.avatar === null ||
          text(value.profile.avatar));
      break;
  }
  if (!valid) return fail();
  return value as unknown as SessionMessage;
}

export function parseSessionMessage(
  raw: unknown,
): SessionMessage {
  if (typeof raw !== "string")
    throw new P2PProtocolError(
      "invalid-message",
      "P2P control messages must be JSON strings",
    );
  try {
    return validateSessionMessage(JSON.parse(raw));
  } catch (error) {
    if (error instanceof P2PProtocolError) throw error;
    throw new P2PProtocolError(
      "invalid-message",
      "Invalid P2P message JSON",
    );
  }
}

export function assertMessagePeer(
  message: SessionMessage,
  peer: ProtocolPeer,
  incoming: boolean,
): void {
  const client = incoming
    ? peer.targetClientId
    : peer.clientId;
  const target = incoming
    ? peer.clientId
    : peer.targetClientId;
  if (
    message.client !== client ||
    message.target !== target
  ) {
    throw new P2PProtocolError(
      "invalid-message",
      "P2P message does not match its owning session",
    );
  }
}

/** Detach a pending request from mutable caller data before any retry. */
export function snapshotSessionMessage<
  T extends SessionMessage,
>(message: T): T {
  let snapshot: SessionMessage;
  try {
    snapshot = parseSessionMessage(JSON.stringify(message));
  } catch (error) {
    if (error instanceof P2PProtocolError) throw error;
    throw new P2PProtocolError(
      "invalid-message",
      "P2P messages must be JSON serializable",
    );
  }
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot as T;
}
