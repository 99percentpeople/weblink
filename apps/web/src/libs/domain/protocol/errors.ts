export type P2PProtocolErrorCode =
  | "already-pending"
  | "timeout"
  | "send-timeout"
  | "aborted"
  | "closed"
  | "remote-error"
  | "send-failed"
  | "invalid-message";

export type RtcProtocolErrorCode = P2PProtocolErrorCode;

export class P2PProtocolError extends Error {
  constructor(
    readonly code: P2PProtocolErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "P2PProtocolError";
  }
}

// Backward-compatible WebRTC-era name.
export { P2PProtocolError as RtcProtocolError };

export function protocolError(
  error: unknown,
  code: P2PProtocolErrorCode = "send-failed",
): P2PProtocolError {
  return error instanceof P2PProtocolError
    ? error
    : new P2PProtocolError(
        code,
        error instanceof Error
          ? error.message
          : String(error),
      );
}

export interface MessageSendOptions {
  signal?: AbortSignal;
  /** Bounds waiting for an underlying transport send, independently of reply timeout. */
  sendTimeoutMs?: number;
}

export interface RequestOptions extends MessageSendOptions {
  /** Starts only after the transport accepts the message for sending. */
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
