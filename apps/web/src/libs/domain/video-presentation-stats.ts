export interface VideoPresentationStats {
  fps?: number;
  onePercentLowFps?: number;
  onePercentLowState?: "estimated" | "unsupported";
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

const LOW_WINDOW_MS = 10_000;
type PresentationSpan = {
  end: number;
  frames: number;
  interval: number;
};

/** Frame intervals ending in the last ten seconds of visible playback.
 * A coalesced callback gives only the mean interval of its submitted frames. */
class PresentationIntervals {
  private readonly spans: PresentationSpan[] = [];
  private lastTime?: number;
  private lastCount?: number;
  reset() {
    this.spans.length = 0;
    this.lastTime = undefined;
    this.lastCount = undefined;
  }
  add(count: number, time: number) {
    if (!Number.isSafeInteger(count) || !valid(time)) {
      this.reset();
      return;
    }
    const gap = count - (this.lastCount ?? count);
    const elapsed = time - (this.lastTime ?? time);
    if (gap < 0 || elapsed < 0) {
      this.reset();
    } else if (
      this.lastTime !== undefined &&
      (!gap || !elapsed)
    ) {
      // Wait for a distinct timestamp before distributing coalesced frames.
      return;
    } else if (gap > 0) {
      this.spans.push({
        end: time,
        frames: gap,
        interval: elapsed / gap,
      });
      // Bound memory even when a diagnostics consumer stops polling.
      if (time - this.spans[0].end > LOW_WINDOW_MS + 1000)
        this.expire(time - LOW_WINDOW_MS);
    }
    this.lastTime = time;
    this.lastCount = count;
  }
  private expire(cutoff: number) {
    let expired = 0;
    while (
      expired < this.spans.length &&
      this.spans[expired].end <= cutoff
    )
      expired++;
    if (expired) this.spans.splice(0, expired);
  }
  low(
    at: number,
  ): Pick<
    VideoPresentationStats,
    "onePercentLowFps" | "onePercentLowState"
  > {
    const cutoff = at - LOW_WINDOW_MS;
    this.expire(cutoff);
    const first = this.spans[0];
    if (!first) return { onePercentLowFps: 0 };
    // A coalesced span can straddle the left edge of the window.
    const count = (s: PresentationSpan) =>
      s === first
        ? Math.min(
            s.frames,
            Math.ceil((s.end - cutoff) / s.interval),
          )
        : s.frames;
    const frames = this.spans.reduce(
      (n, s) => n + count(s),
      0,
    );
    const tail = Math.ceil(frames / 100);
    let remaining = tail;
    let duration = 0;
    for (const span of this.spans
      .slice()
      .sort((a, b) => b.interval - a.interval)) {
      const n = Math.min(remaining, count(span));
      duration += n * span.interval;
      remaining -= n;
      if (!remaining) break;
    }
    return {
      onePercentLowFps: (1000 * tail) / duration,
      onePercentLowState: this.spans.some(
        (s) => s.frames > 1,
      )
        ? "estimated"
        : undefined,
    };
  }
}

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
  const intervals = new PresentationIntervals();
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
        if (valid(metadata.presentedFrames)) {
          intervals.add(
            metadata.presentedFrames,
            metadata.expectedDisplayTime,
          );
          frames = metadata.presentedFrames;
        }
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
    intervals.reset();
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
        ...(callbacks
          ? intervals.low(at)
          : { onePercentLowState: "unsupported" }),
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
