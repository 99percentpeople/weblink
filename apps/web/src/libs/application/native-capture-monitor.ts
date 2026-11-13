import type {
  CaptureStatus,
  NativeCapture,
} from "@weblink/platform";
import { SubscriptionScope } from "@weblink/platform/subscription-scope";

/** The capture owner renews its lease even when every presentation is hidden. */
export function monitorNativeCapture(
  capture: NativeCapture,
  sessionId: string,
  onStatus: (status: CaptureStatus) => void,
  onError: (error: unknown) => void = console.warn,
): () => void {
  const scope = new SubscriptionScope(undefined, onError);
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setTimeout> | undefined;
  scope.add(() => {
    clearTimeout(retry);
    clearTimeout(heartbeat);
  });
  const close = () => scope.dispose();
  const watch = async () => {
    try {
      await scope.track(
        capture.watch(sessionId, (status) => {
          if (
            scope.signal.aborted ||
            status.sessionId !== sessionId
          )
            return;
          if (status.state !== "running") close();
          onStatus(status);
        }),
      );
    } catch (error) {
      if (scope.signal.aborted) return;
      onError(error);
      retry = setTimeout(() => void watch(), 1000);
    }
  };
  const renew = async () => {
    let delay = 10_000;
    try {
      await capture.renew(sessionId);
    } catch (error) {
      if (!scope.signal.aborted) onError(error);
      delay = 1000;
    } finally {
      if (!scope.signal.aborted)
        heartbeat = setTimeout(() => void renew(), delay);
    }
  };
  void watch();
  if (!scope.signal.aborted) void renew();
  return close;
}
