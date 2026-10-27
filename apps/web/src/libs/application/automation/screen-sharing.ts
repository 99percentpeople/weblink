import { AutomationError } from "@weblink/automation";
import { getNativeCaptureStatus } from "../native-screen-service";

interface ScreenSharingPort {
  stream(): MediaStream | null;
  publish(stream: MediaStream): void;
  capture(
    sourceId: string,
    signal: AbortSignal,
  ): Promise<MediaStream>;
}
type SharedScreen = {
  trackId: string;
  sourceId: string;
  reused: boolean;
};

/** The application's published stream owns sharing, not an MCP call or grant. */
export function createScreenSharing(
  port: ScreenSharingPort,
) {
  const pending = new Map<string, Promise<unknown>>();
  const existing = (sourceId: string) =>
    port
      .stream()
      ?.getVideoTracks()
      .find((track) => {
        const capture = getNativeCaptureStatus(track);
        return (
          track.readyState === "live" &&
          capture?.state === "running" &&
          capture.source?.id === sourceId
        );
      });

  return async (
    sourceId: string,
    signal: AbortSignal,
    check: () => Promise<void>,
  ): Promise<SharedScreen> => {
    // Serialize starts for one source; a failed/cancelled request cannot poison
    // another caller. Recheck the live stream and each caller's grant after waiting.
    const request = (
      pending.get(sourceId) ?? Promise.resolve()
    )
      .catch(() => {})
      .then(async () => {
        await check();
        signal.throwIfAborted();
        const shared = existing(sourceId);
        if (shared)
          return {
            trackId: shared.id,
            sourceId,
            reused: true,
          };
        const stream = await port.capture(sourceId, signal);
        const stop = () =>
          stream
            .getTracks()
            .forEach((track) => track.stop());
        try {
          await check();
          signal.throwIfAborted();
          // A manual share may have completed while native capture was starting.
          const shared = existing(sourceId);
          if (shared) {
            stop();
            return {
              trackId: shared.id,
              sourceId,
              reused: true,
            };
          }
          const track = stream
            .getVideoTracks()
            .find((t) => t.readyState === "live");
          if (!track)
            throw new AutomationError("RESOURCE_CLOSED");
          port.publish(
            new MediaStream([
              ...(port.stream()?.getTracks() ?? []),
              ...stream.getTracks(),
            ]),
          );
          return {
            trackId: track.id,
            sourceId,
            reused: false,
          };
        } catch (error) {
          stop();
          throw error;
        }
      });
    pending.set(sourceId, request);
    try {
      return await request;
    } finally {
      if (pending.get(sourceId) === request)
        pending.delete(sourceId);
    }
  };
}
