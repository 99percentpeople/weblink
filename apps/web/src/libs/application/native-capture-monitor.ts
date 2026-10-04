import type {
  CaptureStatus,
  NativeCapture,
} from "@weblink/platform";

/** The capture owner renews its lease even when every presentation is hidden. */
export function monitorNativeCapture(
  capture: NativeCapture,
  sessionId: string,
  onStatus: (status: CaptureStatus) => void,
  onError: (error: unknown) => void = console.warn,
): () => void {
  let closed = false;
  let unwatch: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(retry);
    clearTimeout(heartbeat);
    unwatch?.();
  };
  const watch = async () => {
    try {
      const dispose = await capture.watch(
        sessionId,
        (status) => {
          if (closed || status.sessionId !== sessionId)
            return;
          if (status.state !== "running") close();
          onStatus(status);
        },
      );
      if (closed) dispose();
      else unwatch = dispose;
    } catch (error) {
      if (closed) return;
      onError(error);
      retry = setTimeout(() => void watch(), 1000);
    }
  };
  const renew = async () => {
    let delay = 10_000;
    try {
      await capture.renew(sessionId);
    } catch (error) {
      if (!closed) onError(error);
      delay = 1000;
    } finally {
      if (!closed)
        heartbeat = setTimeout(() => void renew(), delay);
    }
  };
  void watch();
  if (!closed) void renew();
  return close;
}
