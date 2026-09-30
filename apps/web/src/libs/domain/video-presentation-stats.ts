export interface VideoPresentationStats {
  fps?: number;
  droppedPerSecond?: number;
  receiveToPresentMs?: number;
}
export interface VideoPresentationSampler {
  read(at?: number): VideoPresentationStats;
  close(): void;
}

const valid = (value: number | undefined) =>
  value !== undefined &&
  Number.isFinite(value) &&
  value >= 0;

/** Compositor submissions, not decoder output or physical display scan-out.
 * Read cumulative presentedFrames: callback count undercounts a busy main thread. */
export function createVideoPresentationStats(
  video: HTMLVideoElement,
): VideoPresentationSampler {
  const document = video.ownerDocument;
  const callbacks =
    typeof video.requestVideoFrameCallback === "function" &&
    typeof video.cancelVideoFrameCallback === "function";
  let closed = false;
  let callback: number | undefined;
  let frames: number | undefined;
  let receiveToPresentMs: number | undefined;
  let timingAt: number | undefined;
  let previous:
    | { at: number; frames?: number; dropped?: number }
    | undefined;
  const schedule = () => {
    if (
      closed ||
      document.hidden ||
      !callbacks ||
      callback !== undefined
    )
      return;
    callback = video.requestVideoFrameCallback(
      (now, metadata) => {
        callback = undefined;
        if (closed || document.hidden) return;
        if (valid(metadata.presentedFrames))
          frames = metadata.presentedFrames;
        const receiveTime = (
          metadata as VideoFrameCallbackMetadata & {
            receiveTime?: number;
          }
        ).receiveTime;
        receiveToPresentMs =
          valid(receiveTime) &&
          valid(metadata.expectedDisplayTime) &&
          metadata.expectedDisplayTime >= receiveTime!
            ? metadata.expectedDisplayTime - receiveTime!
            : undefined;
        timingAt = now;
        schedule();
      },
    );
  };
  const reset = () => {
    if (callback !== undefined)
      video.cancelVideoFrameCallback(callback);
    callback = undefined;
    frames = receiveToPresentMs = timingAt = undefined;
    previous = undefined;
    schedule();
  };
  document.addEventListener("visibilitychange", reset);
  schedule();
  return {
    read(at = performance.now()): VideoPresentationStats {
      if (closed || document.hidden) {
        previous = undefined;
        return {};
      }
      const quality = video.getVideoPlaybackQuality?.();
      const dropped = valid(quality?.droppedVideoFrames)
        ? quality!.droppedVideoFrames
        : undefined;
      // On older browsers, totalVideoFrames includes dropped frames.
      const presented = callbacks
        ? frames
        : valid(quality?.totalVideoFrames) &&
            dropped !== undefined &&
            quality!.totalVideoFrames >= dropped
          ? quality!.totalVideoFrames - dropped
          : undefined;
      const rate = (now?: number, before?: number) =>
        previous &&
        at > previous.at &&
        now !== undefined &&
        before !== undefined &&
        now >= before
          ? ((now - before) * 1000) / (at - previous.at)
          : undefined;
      const value: VideoPresentationStats = {
        fps: rate(presented, previous?.frames),
        droppedPerSecond: rate(dropped, previous?.dropped),
        // This is receiver-to-presentation timing, never glass-to-glass latency.
        receiveToPresentMs:
          timingAt !== undefined &&
          at >= timingAt &&
          at - timingAt <= 1500
            ? receiveToPresentMs
            : undefined,
      };
      previous = { at, frames: presented, dropped };
      return value;
    },
    close() {
      if (closed) return;
      closed = true;
      document.removeEventListener(
        "visibilitychange",
        reset,
      );
      reset();
    },
  };
}
