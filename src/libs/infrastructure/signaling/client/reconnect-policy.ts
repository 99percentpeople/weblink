export const WEBSOCKET_CONNECTION_TIMEOUT_MS = 10_000;
export const WEBSOCKET_JOIN_ACK_TIMEOUT_MS = 2_000;
export const WEBSOCKET_SIGNALING_PROTOCOL_VERSION = 2;
export const WEBSOCKET_RECONNECT_BASE_DELAY_MS = 500;
export const WEBSOCKET_RECONNECT_MAX_DELAY_MS = 15_000;

export interface ReconnectBackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
}

/**
 * Exponential backoff with equal jitter. Attempt numbers start at 1.
 */
export function getReconnectDelayMs(
  attempt: number,
  options: ReconnectBackoffOptions = {},
): number {
  const baseDelayMs =
    options.baseDelayMs ??
    WEBSOCKET_RECONNECT_BASE_DELAY_MS;
  const maxDelayMs =
    options.maxDelayMs ?? WEBSOCKET_RECONNECT_MAX_DELAY_MS;
  const random = options.random ?? Math.random;
  const exponent = Math.max(0, attempt - 1);
  const cappedDelay = Math.min(
    maxDelayMs,
    baseDelayMs * 2 ** exponent,
  );
  const jitter = Math.min(1, Math.max(0, random()));

  return Math.round(
    cappedDelay / 2 + (cappedDelay / 2) * jitter,
  );
}

/**
 * Wait for the next retry. Coming online bypasses the remaining delay;
 * while offline, retries pause until the browser reports connectivity.
 */
export function waitForReconnect(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();

  return new Promise<void>((resolve) => {
    const eventTarget =
      typeof window === "undefined" ? null : window;
    const isOnline =
      typeof navigator === "undefined" ||
      navigator.onLine !== false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      signal.removeEventListener("abort", finish);
      eventTarget?.removeEventListener("online", finish);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    signal.addEventListener("abort", finish, {
      once: true,
    });
    eventTarget?.addEventListener("online", finish, {
      once: true,
    });

    if (isOnline) {
      timer = setTimeout(finish, Math.max(0, delayMs));
    }
  });
}
