import { encodeSignalingEnvelope } from "@/libs/domain/signaling-protocol";

export const WEBSOCKET_HEARTBEAT_INTERVAL_MS = 15_000;
export const WEBSOCKET_HEARTBEAT_TIMEOUT_MS = 10_000;

/** Detect half-open transports even when the browser never emits close/error. */
export function startSocketHeartbeat(
  socket: WebSocket,
  signal: AbortSignal,
  onUnresponsive: () => void,
): void {
  if (signal.aborted) return;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let probeStartedAt: number | null = null;

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const stop = () => {
    clearTimer();
    controller.abort();
    signal.removeEventListener("abort", stop);
  };
  const expire = () => {
    if (controller.signal.aborted) return;
    stop();
    onUnresponsive();
  };
  const probe = () => {
    if (controller.signal.aborted) return;
    // Repeated focus/online events must not extend an unanswered probe. Check
    // wall time as well, since timers may have been suspended with the page.
    if (probeStartedAt !== null) {
      if (
        Date.now() - probeStartedAt >=
        WEBSOCKET_HEARTBEAT_TIMEOUT_MS
      )
        expire();
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) {
      expire();
      return;
    }
    clearTimer();
    probeStartedAt = Date.now();
    timer = setTimeout(
      expire,
      WEBSOCKET_HEARTBEAT_TIMEOUT_MS,
    );
    try {
      // The worker's hibernation auto-response matches this exact envelope.
      socket.send(
        encodeSignalingEnvelope({
          type: "ping",
          data: undefined,
        }),
      );
    } catch {
      expire();
    }
  };
  const schedule = () => {
    if (controller.signal.aborted) return;
    clearTimer();
    probeStartedAt = null;
    timer = setTimeout(
      probe,
      WEBSOCKET_HEARTBEAT_INTERVAL_MS,
    );
  };

  signal.addEventListener("abort", stop, { once: true });
  // Any incoming frame proves the transport is responsive, including the
  // server-driven ping used by legacy servers (which may not implement pong).
  socket.addEventListener("message", schedule, {
    signal: controller.signal,
  });
  socket.addEventListener("close", stop, {
    signal: controller.signal,
  });
  if (typeof window !== "undefined") {
    for (const event of ["online", "focus", "pageshow"]) {
      window.addEventListener(event, probe, {
        signal: controller.signal,
      });
    }
  }
  if (typeof document !== "undefined") {
    document.addEventListener("resume", probe, {
      signal: controller.signal,
    });
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") probe();
      },
      { signal: controller.signal },
    );
  }
  schedule();
}
