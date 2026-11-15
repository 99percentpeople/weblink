/** Shared browser/native presentation measurements. Missing fields mean unavailable.
 * FPS counts compositor submissions, not decoded frames or physical scan-out. */
export interface VideoPresentationStats {
  fps?: number;
  /** Reciprocal of the mean slowest 1% of completed frame intervals in the
   * last ten seconds of visible playback. Zero means no completed intervals. */
  onePercentLowFps?: number;
  /** Coalesced or bounded samples are estimates; absent means measured. */
  onePercentLowState?: "estimated" | "unsupported";
  droppedPerSecond?: number;
  /** Receiver-to-presentation timing, never end-to-end latency. */
  receiveToPresentMs?: number;
  totalFrames?: number;
  implementation?: string;
}

export interface VideoPresentationSampler {
  read(at?: number): VideoPresentationStats;
  close(): void;
}
