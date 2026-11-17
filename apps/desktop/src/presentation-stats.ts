import type {
  VideoPresentationSampler,
  VideoPresentationStats,
} from "@weblink/platform";

export interface NativePresentationSnapshot {
  at: number;
  frames: number;
  visible: boolean;
  submitMs?: number;
  presentationQueueMs?: number;
  endToEndMs?: number | null;
  endToEndAgeMs?: number | null;
  timingAgeMs?: number | null;
  captureToReceiveMs?: number | null;
  receiveToPresentMs?: number | null;
  decodeToPresentMs?: number | null;
  onePercentLowFps?: number | null;
  onePercentLowState?:
    | VideoPresentationStats["onePercentLowState"]
    | null;
}

export function createNativePresentationStats(
  current: () => NativePresentationSnapshot,
): VideoPresentationSampler {
  let previous: { at: number; frames: number } | undefined;
  let fps: number | undefined;
  let closed = false;
  return {
    read(at = performance.now()) {
      const sample = current();
      if (
        closed ||
        !sample.visible ||
        !Number.isFinite(sample.at) ||
        !Number.isSafeInteger(sample.frames) ||
        sample.frames < 0 ||
        sample.at < 0
      ) {
        previous = undefined;
        fps = undefined;
        return {};
      }
      if (
        previous &&
        (sample.at < previous.at ||
          sample.frames < previous.frames)
      ) {
        previous = undefined;
        fps = undefined;
      }
      if (previous && sample.at > previous.at) {
        const elapsed = sample.at - previous.at;
        const delta = sample.frames - previous.frames;
        fps =
          delta >= 0 && elapsed <= 3000
            ? (delta * 1000) / elapsed
            : undefined;
      }
      if (!previous || sample.at !== previous.at)
        previous = { at: sample.at, frames: sample.frames };
      const low = sample.onePercentLowFps;
      const hasLow =
        sample.onePercentLowState !== "unsupported" &&
        typeof low === "number" &&
        Number.isFinite(low) &&
        low >= 0;
      const age =
        sample.timingAgeMs ?? sample.endToEndAgeMs;
      const fresh =
        typeof age === "number" &&
        Number.isFinite(age) &&
        age >= 0 &&
        at >= sample.at &&
        age + at - sample.at <= 1500;
      const timing = (value?: number | null) =>
        fresh &&
        sample.frames > 0 &&
        typeof value === "number" &&
        Number.isFinite(value) &&
        value >= 0
          ? value
          : undefined;
      const endToEndMs = timing(sample.endToEndMs);
      return {
        fps,
        ...(fresh
          ? {
              latencyEndpoint: "compositor-submit" as const,
            }
          : {}),
        captureToReceiveMs: timing(
          sample.captureToReceiveMs,
        ),
        receiveToPresentMs: timing(
          sample.receiveToPresentMs,
        ),
        decodeToPresentMs: timing(sample.decodeToPresentMs),
        ...(endToEndMs !== undefined
          ? { endToEndMs, endToEndState: "estimated" }
          : {}),
        submitMs: timing(sample.submitMs),
        presentationQueueMs: timing(
          sample.presentationQueueMs,
        ),
        onePercentLowFps: hasLow ? low : undefined,
        onePercentLowState: hasLow
          ? sample.onePercentLowState === "estimated"
            ? "estimated"
            : undefined
          : "unsupported",
        totalFrames: sample.frames,
        implementation: "D3D11 / DirectComposition",
      };
    },
    close() {
      closed = true;
      previous = undefined;
      fps = undefined;
    },
  };
}
