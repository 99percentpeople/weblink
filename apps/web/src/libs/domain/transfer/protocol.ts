export const FILE_TRANSFER_CHANNEL_PROTOCOL = "transfer";

export type TransferChunkRange = number | [number, number];

export interface TransferHeadMetadata {
  id: string;
  fileName: string;
  fileSize: number;
  lastModified?: number;
  mimetype?: string;
  chunkSize?: number;
  from?: string;
  createdAt?: number;
}

export interface BaseTransferMessage {
  type: string;
}

export interface HeadMessage
  extends BaseTransferMessage, TransferHeadMetadata {
  type: "head";
}

export interface RequestContentMessage extends BaseTransferMessage {
  type: "request-content";
  ranges: TransferChunkRange[];
}

export interface RequestHeadMessage extends BaseTransferMessage {
  type: "request-head";
}

export interface CompleteMessage extends BaseTransferMessage {
  type: "complete";
}

export interface PauseMessage extends BaseTransferMessage {
  type: "pause";
}

export type TransferMessage =
  | RequestContentMessage
  | RequestHeadMessage
  | HeadMessage
  | CompleteMessage
  | PauseMessage;

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function nonNegativeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function positiveInteger(value: unknown): value is number {
  return nonNegativeInteger(value) && value > 0;
}

function optional(
  value: unknown,
  check: (value: unknown) => boolean,
): boolean {
  return value === undefined || check(value);
}

function validRange(
  value: unknown,
): value is TransferChunkRange {
  if (nonNegativeInteger(value)) return true;
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    nonNegativeInteger(value[0]) &&
    nonNegativeInteger(value[1]) &&
    value[0] <= value[1]
  );
}

function validHead(
  value: Record<string, unknown>,
): boolean {
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.fileName === "string" &&
    nonNegativeInteger(value.fileSize) &&
    optional(value.lastModified, nonNegativeInteger) &&
    optional(
      value.mimetype,
      (item) => typeof item === "string",
    ) &&
    optional(value.chunkSize, positiveInteger) &&
    optional(
      value.from,
      (item) => typeof item === "string",
    ) &&
    optional(value.createdAt, nonNegativeInteger)
  );
}

export function validateTransferMessage(
  value: unknown,
): TransferMessage {
  if (!isRecord(value)) {
    throw new Error("Invalid file transfer message");
  }

  switch (value.type) {
    case "request-head":
      return { type: "request-head" };
    case "complete":
      return { type: "complete" };
    case "pause":
      return { type: "pause" };
    case "request-content":
      if (
        Array.isArray(value.ranges) &&
        value.ranges.every(validRange)
      ) {
        return {
          type: "request-content",
          ranges: value.ranges as TransferChunkRange[],
        };
      }
      break;
    case "head":
      if (validHead(value)) {
        return {
          type: "head",
          id: value.id as string,
          fileName: value.fileName as string,
          fileSize: value.fileSize as number,
          lastModified: value.lastModified as
            | number
            | undefined,
          mimetype: value.mimetype as string | undefined,
          chunkSize: value.chunkSize as number | undefined,
          from: value.from as string | undefined,
          createdAt: value.createdAt as number | undefined,
        };
      }
      break;
  }

  throw new Error("Invalid file transfer message");
}

export function parseTransferMessage(
  raw: string,
): TransferMessage {
  try {
    return validateTransferMessage(JSON.parse(raw));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "Invalid file transfer message"
    ) {
      throw error;
    }
    throw new Error("Invalid file transfer message");
  }
}

export function encodeTransferMessage(
  message: TransferMessage,
): string {
  return JSON.stringify(message);
}
