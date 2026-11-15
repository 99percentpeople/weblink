import type {
  VideoPresentationSampler,
  VideoPresentationStats,
} from "@weblink/platform";

export interface NativePresentationSnapshot {
  at: number;
  frames: number;
  visible: boolean;
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
    read() {
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
      return {
        fps,
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
