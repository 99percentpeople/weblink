export type RtcProtocolErrorCode =
  | "already-pending"
  | "timeout"
  | "send-timeout"
  | "aborted"
  | "closed"
  | "remote-error"
  | "send-failed"
  | "invalid-message";

export class RtcProtocolError extends Error {
  constructor(
    readonly code: RtcProtocolErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "RtcProtocolError";
  }
}

export function protocolError(
  error: unknown,
  code: RtcProtocolErrorCode = "send-failed",
): RtcProtocolError {
  return error instanceof RtcProtocolError
    ? error
    : new RtcProtocolError(
        code,
        error instanceof Error
          ? error.message
          : String(error),
      );
}

export interface MessageSendOptions {
  signal?: AbortSignal;
  /** Bounds waiting for a writable channel, independently of reply timeout. */
  sendTimeoutMs?: number;
}

export interface RequestOptions extends MessageSendOptions {
  /** Starts only after DataChannel.send() accepts the message. */
  timeoutMs?: number;
  /** Retries keep the exact same ID, timestamp and payload. */
  retries?: number;
  retryDelayMs?: number;
}

export function positiveTimeout(
  value: number,
  name: string,
): number {
  if (
    !Number.isFinite(value) ||
    value <= 0 ||
    value > 2_147_483_647
  ) {
    throw new RangeError(
      `${name} must be a positive finite timeout`,
    );
  }
  return value;
}
