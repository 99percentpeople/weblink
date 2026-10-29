/** Estimate presentation cadence, never video content FPS. Reject throttling and unstable samples. */
export function estimateDisplayFrameRate(
  intervals: readonly number[],
): number | undefined {
  const samples = intervals
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 40)
    .sort((a, b) => a - b);
  if (
    samples.length < 90 ||
    samples.length < intervals.length * 0.95
  )
    return;
  // Dropped callbacks produce integer multiples of a display period. Find a
  // recurring short-interval cluster, not the median of delivered callbacks:
  // a mixture of 8.3/16.7 ms still contains positive evidence of 120 Hz.
  // A percentile and a minimum cluster size reject isolated short outliers.
  const short = samples[Math.floor(samples.length * 0.2)];
  const fast = samples.filter(
    (n) => Math.abs(n - short) <= short * 0.15,
  );
  if (fast.length < Math.max(24, samples.length * 0.2))
    return;
  const period =
    fast.reduce((sum, n) => sum + n, 0) / fast.length;
  const consistent = samples.filter((n) => {
    const multiple = Math.round(n / period);
    return (
      multiple >= 1 &&
      Math.abs(n - multiple * period) <= period * 0.12
    );
  });
  if (consistent.length < samples.length * 0.9) return;
  const rate = 1000 / period;
  const common = [
    30, 48, 50, 60, 72, 75, 90, 100, 120, 144, 165, 180,
    200, 240, 360, 480,
  ];
  return (
    common.find(
      (fps) => Math.abs(fps - rate) / fps < 0.025,
    ) ?? Math.round(rate)
  );
}

/** rAF can slow down without the display changing. Keep the highest confirmed
 * cadence for this display context instead of feeding scheduling load back into
 * the video sender. A different display context starts a new calibration. */
export class DisplayFrameRateCalibration {
  private display?: string;
  private confirmed = 0;
  private candidate = 0;
  private windows = 0;
  private evidenceMs = 0;
  private lastEvidence = 0;

  resetEvidence(): void {
    this.candidate = 0;
    this.windows = 0;
    this.evidenceMs = 0;
    this.lastEvidence = 0;
  }

  sample(
    intervals: readonly number[],
    now: number,
    display: string,
  ): number | undefined {
    if (display !== this.display) {
      this.display = display;
      this.confirmed = 0;
      this.resetEvidence();
    }
    if (this.windows && now - this.lastEvidence > 5000)
      this.resetEvidence();
    const fps = estimateDisplayFrameRate(intervals);
    // A slow/noisy window provides no higher-rate evidence, but does not
    // invalidate recent faster samples. Otherwise intermittent 60/120 windows
    // can leave a 120 Hz display stuck at its first 60 Hz estimate forever.
    if (!fps || fps <= this.confirmed * 1.03) return;
    if (this.candidate && fps < this.candidate * 0.97)
      return;
    if (
      this.candidate &&
      Math.abs(fps - this.candidate) / this.candidate <=
        0.03
    ) {
      ++this.windows;
    } else {
      this.candidate = fps;
      this.windows = 1;
      this.evidenceMs = 0;
    }
    this.lastEvidence = now;
    this.evidenceMs += intervals.reduce(
      (sum, interval) =>
        sum +
        (Number.isFinite(interval) &&
        interval >= 1 &&
        interval <= 40
          ? interval
          : 0),
      0,
    );
    // Only supporting sample windows count toward calibration. Long pauses and
    // intervening slower windows must not shorten the required evidence.
    if (this.windows < 3 || this.evidenceMs < 3000) return;
    this.confirmed = this.candidate;
    this.resetEvidence();
    return this.confirmed;
  }
}

function displayContext(): string {
  const view = document.defaultView;
  const screen = view?.screen as
    | (Screen & { availLeft?: number; availTop?: number })
    | undefined;
  return [
    screen?.width,
    screen?.height,
    screen?.availLeft,
    screen?.availTop,
    view?.devicePixelRatio,
  ].join(":");
}

export function observeDisplayFrameRate(
  changed: (fps: number) => void,
  signal: AbortSignal,
): void {
  if (
    typeof requestAnimationFrame === "undefined" ||
    typeof document === "undefined" ||
    signal.aborted
  )
    return;
  let handle = 0;
  let previous: number | undefined;
  let display = displayContext();
  const calibration = new DisplayFrameRateCalibration();
  let samples: number[] = [];
  const reset = () => {
    previous = undefined;
    samples = [];
    calibration.resetEvidence();
  };
  const tick = (now: number) => {
    if (signal.aborted) return;
    if (document.visibilityState !== "visible") reset();
    else {
      if (previous !== undefined)
        samples.push(now - previous);
      previous = now;
      if (samples.length >= 120) {
        const nextDisplay = displayContext();
        if (nextDisplay !== display) {
          display = nextDisplay;
          // Discard a batch that may span two monitors. Keep the last applied
          // limit until there is enough evidence from the new display.
          reset();
        } else {
          const fps = calibration.sample(
            samples,
            now,
            display,
          );
          samples = [];
          if (fps) changed(fps);
        }
      }
    }
    if (!signal.aborted)
      handle = requestAnimationFrame(tick);
  };
  document.addEventListener("visibilitychange", reset, {
    signal,
  });
  signal.addEventListener(
    "abort",
    () => cancelAnimationFrame(handle),
    { once: true },
  );
  handle = requestAnimationFrame(tick);
}
