/** A diagnostic protocol, separate from file transfer and signaling. */
export const SPEED_TEST_PROTOCOL = "weblink-speedtest-v1";
export const SPEED_TEST_DURATION_MS = 10_000;
export const SPEED_TEST_MAX_BYTES = 64 * 1024 * 1024;
export const SPEED_TEST_BLOCK_BYTES = 32 * 1024;
export const SPEED_TEST_HIGH_WATER = 256 * 1024;
export const SPEED_TEST_LOW_WATER = 64 * 1024;
export const SPEED_TEST_APPROVAL_MS = 20_000;
export const SPEED_TEST_HANDSHAKE_MS = 5_000;
export const SPEED_TEST_PHASE_TIMEOUT_MS = 15_000;
export const SPEED_TEST_TOTAL_TIMEOUT_MS = 60_000;

/** Directions on the wire are relative to the initiator. */
export type SpeedTestDirection = "upload" | "download";
export type SpeedTestErrorCode =
  | "busy"
  | "offline"
  | "unsupported"
  | "declined"
  | "cancelled"
  | "timeout"
  | "closed"
  | "protocol"
  | "failed";

export class SpeedTestError extends Error {
  constructor(public readonly code: SpeedTestErrorCode) {
    super(`Speed test: ${code}`);
    this.name = "SpeedTestError";
  }
}

export interface SpeedMeasurement {
  bytes: number;
  durationMs: number;
  bytesPerSecond: number;
}

export interface SpeedTestResult {
  /** Local -> remote, irrespective of who initiated the test. */
  upload: SpeedMeasurement;
  /** Remote -> local. */
  download: SpeedMeasurement;
  completedAt: number;
}

export interface SpeedTestProgress {
  phase: "connecting" | "approval" | "upload" | "download";
  /** Live queued/received bytes, not an acknowledged speed estimate. */
  bytes: number;
}

export type SpeedTestMessage =
  | { type: "hello"; durationMs: number; maxBytes: number }
  | { type: "offer" }
  | { type: "ready" }
  | { type: "reject"; reason: "busy" | "declined" }
  | {
      type: "start" | "go" | "begin";
      direction: SpeedTestDirection;
    }
  | {
      type: "end";
      direction: SpeedTestDirection;
      bytes: number;
    }
  | {
      type: "receipt";
      direction: SpeedTestDirection;
      bytes: number;
      durationMs: number;
    };

export function encodeSpeedTestMessage(
  message: SpeedTestMessage,
): string {
  return JSON.stringify(message);
}

export function parseSpeedTestMessage(
  raw: string,
): SpeedTestMessage {
  if (raw.length > 1024)
    throw new SpeedTestError("protocol");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SpeedTestError("protocol");
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new SpeedTestError("protocol");
  }
  const message = value as Record<string, unknown>;
  const integer = (n: unknown, max: number): n is number =>
    typeof n === "number" &&
    Number.isSafeInteger(n) &&
    n > 0 &&
    n <= max;
  switch (message.type) {
    case "hello":
      if (
        integer(
          message.durationMs,
          SPEED_TEST_DURATION_MS,
        ) &&
        integer(message.maxBytes, SPEED_TEST_MAX_BYTES)
      ) {
        return {
          type: "hello",
          durationMs: message.durationMs,
          maxBytes: message.maxBytes,
        };
      }
      break;
    case "offer":
    case "ready":
      return { type: message.type };
    case "reject":
      if (
        message.reason === "busy" ||
        message.reason === "declined"
      ) {
        return { type: "reject", reason: message.reason };
      }
      break;
    case "start":
    case "go":
    case "begin":
    case "end":
    case "receipt": {
      const direction = message.direction;
      if (
        direction !== "upload" &&
        direction !== "download"
      )
        break;
      if (
        message.type === "start" ||
        message.type === "go" ||
        message.type === "begin"
      ) {
        return { type: message.type, direction };
      }
      if (!integer(message.bytes, SPEED_TEST_MAX_BYTES))
        break;
      if (message.type === "end")
        return {
          type: "end",
          direction,
          bytes: message.bytes,
        };
      if (
        typeof message.durationMs === "number" &&
        Number.isFinite(message.durationMs) &&
        message.durationMs > 0 &&
        message.durationMs <= SPEED_TEST_PHASE_TIMEOUT_MS
      ) {
        return {
          type: "receipt",
          direction,
          bytes: message.bytes,
          durationMs: message.durationMs,
        };
      }
    }
  }
  throw new SpeedTestError("protocol");
}

export function speedMeasurement(
  bytes: number,
  durationMs: number,
): SpeedMeasurement {
  return {
    bytes,
    durationMs,
    bytesPerSecond: (bytes * 1000) / durationMs,
  };
}
