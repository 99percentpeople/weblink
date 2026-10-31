export function createNativePresentationStats(
  current: () => {
    at: number;
    frames: number;
    visible: boolean;
  },
) {
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
        !Number.isFinite(sample.frames)
      ) {
        previous = undefined;
        fps = undefined;
        return {};
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
        previous = sample;
      return {
        fps,
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
