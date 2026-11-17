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
  /** Same remote frame's capture to compositor submission on the receiver
   * clock, on both platforms. Not expected display or physical scan-out. */
  endToEndMs?: number;
  /** Cross-device capture-clock mapping makes this an estimate. */
  endToEndState?: "estimated";
  /** Explicit boundary for exported timings, including recordings of older builds. */
  latencyEndpoint?: "compositor-submit";
  /** Same frame's capture to LAST packet received, estimated clock mapping.
   * Includes sender processing, packetization, pacing, transit and waiting
   * for all packets; remaining assembly work belongs to receiveToPresentMs. */
  captureToReceiveMs?: number;
  /** LAST packet received to compositor submission, same frame.
   * When both are available, captureToReceiveMs + this = endToEndMs. */
  receiveToPresentMs?: number;
  /** Decoder completion to compositor submission, same frame; a SUBSET of
   * receiveToPresentMs, including bridge/upload/queue/submission. */
  decodeToPresentMs?: number;
  /** Browser-only estimated submission-to-display wait; outside endToEndMs. */
  displayWaitMs?: number;
  /** Same frame's decoder processing duration, when supplied by the browser.
   * Diagnostic only; cannot be combined with unrelated interval averages. */
  frameDecodeMs?: number;
  /** Latest completed frame's submission call to the presentation backend. */
  submitMs?: number;
  /** Latest completed frame's wait from ready to presentation submission. */
  presentationQueueMs?: number;
  totalFrames?: number;
  implementation?: string;
}

export interface VideoPresentationSampler {
  read(at?: number): VideoPresentationStats;
  close(): void;
}
