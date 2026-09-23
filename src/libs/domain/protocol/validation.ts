import type {
  ProtocolPeer,
  SessionMessage,
} from "./messages";
import { P2PProtocolError } from "./errors";
import {
  P2P_STORAGE_PROTOCOL_VERSION,
  P2P_ROOM_CHAT_PROTOCOL_VERSION,
  P2P_ROOM_FILE_PROTOCOL_VERSION,
  ROOM_CHAT_MAX_TEXT_LENGTH,
  STORAGE_MAX_PAGE_SIZE,
  STORAGE_MAX_SEARCH_LENGTH,
  STORAGE_SORT_FIELDS,
} from "./messages";

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

function roomBinding(
  value: Record<string, unknown>,
): boolean {
  return (
    id(value.roomId) &&
    value.roomId.length <= 256 &&
    id(value.senderToken) &&
    value.senderToken.length <= 128 &&
    id(value.recipientToken) &&
    value.recipientToken.length <= 128
  );
}

function roomSender(
  value: Record<string, unknown>,
): boolean {
  return (
    text(value.senderName) &&
    value.senderName.length <= 128 &&
    (value.senderAvatar === null ||
      (text(value.senderAvatar) &&
        value.senderAvatar.length <= 256 * 1024))
  );
}

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

function pagination(
  value: Record<string, unknown>,
): boolean {
  return (
    integer(value.pageIndex) &&
    integer(value.pageSize) &&
    value.pageSize > 0 &&
    value.pageSize <= STORAGE_MAX_PAGE_SIZE &&
    Number.isSafeInteger(value.pageIndex * value.pageSize)
  );
}

function storageQuery(
  value: Record<string, unknown>,
): boolean {
  return (
    pagination(value) &&
    optional(
      value.search,
      (search) =>
        text(search) &&
        search.length <= STORAGE_MAX_SEARCH_LENGTH,
    ) &&
    optional(
      value.sort,
      (sort) =>
        Array.isArray(sort) &&
        sort.length <= STORAGE_SORT_FIELDS.length &&
        sort.every(
          (item) =>
            record(item) &&
            STORAGE_SORT_FIELDS.some(
              (field) => field === item.field,
            ) &&
            typeof item.desc === "boolean",
        ) &&
        new Set(sort.map((item) => item.field)).size ===
          sort.length,
    )
  );
}

function storagePage(value: unknown): boolean {
  if (
    !record(value) ||
    !pagination(value) ||
    !integer(value.totalCount) ||
    typeof value.sharingEnabled !== "boolean" ||
    !Array.isArray(value.items)
  )
    return false;
  const pageIndex = value.pageIndex as number;
  const pageSize = value.pageSize as number;
  const lastPage = Math.max(
    0,
    Math.ceil(value.totalCount / pageSize) - 1,
  );
  return (
    pageIndex <= lastPage &&
    (value.sharingEnabled || value.totalCount === 0) &&
    value.items.length ===
      Math.min(
        pageSize,
        Math.max(
          0,
          value.totalCount - pageIndex * pageSize,
        ),
      ) &&
    value.items.every(
      (item) =>
        record(item) &&
        fileMetadata(item, true) &&
        optional(item.createdAt, timestamp) &&
        optional(item.from, id) &&
        Object.keys(item).every((key) =>
          [
            "id",
            "fileName",
            "fileSize",
            "lastModified",
            "mimetype",
            "chunkSize",
            "from",
            "createdAt",
          ].includes(key),
        ),
    ) &&
    new Set(value.items.map((item) => item.id)).size ===
      value.items.length
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
  // These are local history fields, never wire metadata. In particular, a
  // legacy send-text must not smuggle itself into a room via object spreading
  // in a storage projection and bypass the room handler's binding checks.
  if (
    [
      "conversationId",
      "room",
      "deliveries",
      "roomTransfers",
      "localSequence",
      "lastReadSequence",
    ].some((key) => Object.hasOwn(value, key))
  )
    return fail();
  let valid = false;
  switch (value.type) {
    case "room-capabilities":
      valid =
        value.version === P2P_ROOM_CHAT_PROTOCOL_VERSION &&
        id(value.roomId) &&
        value.roomId.length <= 256 &&
        id(value.token) &&
        value.token.length <= 128 &&
        optional(
          value.features,
          (features) =>
            Array.isArray(features) &&
            features.length <= 16 &&
            features.every(
              (feature) =>
                text(feature) &&
                feature.length > 0 &&
                feature.length <= 64,
            ),
        );
      break;
    case "send-room-file":
      valid =
        value.version === P2P_ROOM_FILE_PROTOCOL_VERSION &&
        roomBinding(value) &&
        roomSender(value) &&
        fileMetadata(value, false) &&
        (value.fileName as string).length > 0 &&
        (value.fileName as string).length <= 1024 &&
        optional(
          value.mimeType,
          (mime) => text(mime) && mime.length <= 255,
        ) &&
        Object.keys(value).every((key) =>
          [
            "id",
            "type",
            "createdAt",
            "client",
            "target",
            "version",
            "roomId",
            "senderToken",
            "recipientToken",
            "senderName",
            "senderAvatar",
            "fid",
            "fileName",
            "fileSize",
            "mimeType",
            "lastModified",
            "chunkSize",
          ].includes(key),
        );
      break;
    case "request-room-file":
      valid =
        value.version === P2P_ROOM_FILE_PROTOCOL_VERSION &&
        roomBinding(value) &&
        id(value.offerId) &&
        value.offerId !== value.id &&
        id(value.fid) &&
        typeof value.resume === "boolean" &&
        optional(value.ranges, (items) =>
          ranges(items, Number.MAX_SAFE_INTEGER),
        ) &&
        Object.keys(value).every((key) =>
          [
            "id",
            "type",
            "createdAt",
            "client",
            "target",
            "version",
            "roomId",
            "senderToken",
            "recipientToken",
            "offerId",
            "fid",
            "ranges",
            "resume",
          ].includes(key),
        );
      // The authorized offer supplies the actual chunk count for range checks.
      break;
    case "send-room-text":
      valid =
        value.version === P2P_ROOM_CHAT_PROTOCOL_VERSION &&
        id(value.roomId) &&
        value.roomId.length <= 256 &&
        id(value.senderToken) &&
        value.senderToken.length <= 128 &&
        id(value.recipientToken) &&
        value.recipientToken.length <= 128 &&
        text(value.senderName) &&
        value.senderName.length <= 128 &&
        (value.senderAvatar === null ||
          (text(value.senderAvatar) &&
            value.senderAvatar.length <= 256 * 1024)) &&
        text(value.data) &&
        value.data.trim().length > 0 &&
        value.data.length <= ROOM_CHAT_MAX_TEXT_LENGTH;
      break;
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
      valid = true;
      break;
    case "storage-changed":
      valid = Object.keys(value).every((key) =>
        [
          "id",
          "type",
          "createdAt",
          "client",
          "target",
        ].includes(key),
      );
      break;
    case "request-storage":
      valid =
        value.version === P2P_STORAGE_PROTOCOL_VERSION &&
        storageQuery(value);
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
        value.version === P2P_STORAGE_PROTOCOL_VERSION &&
        storagePage(value.data);
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
