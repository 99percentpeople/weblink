/** Only known, bounded diagnostic fields cross from native reports into exports. */
export interface ReceiveStageTiming {
  count: number;
  totalMs: number;
  maxMs: number;
  windowCount: number;
  p50Ms?: number;
  p95Ms?: number;
}
export interface NativeReceivePipelineStats {
  mode: "push" | "gpu";
  slots: number;
  decodedFrames?: number;
  sharedCopies?: number;
  pushedFrames?: number;
  skippedBeforeCopy?: number;
  releasedFrames?: number;
  releaseMessages?: number;
  invalidReleases?: number;
  workerQueueMs?: ReceiveStageTiming;
  decodedQueueMs?: ReceiveStageTiming;
  pixelCopyMs?: ReceiveStageTiming;
  leaseHoldMs?: ReceiveStageTiming;
  renderer?: {
    path?: "d3d11-composition";
    presentedFrames?: number;
    uploadedFrames?: number;
    decodedQueueMs?: number;
    submitMs?: number;
    receivedFrames?: number;
    submittedFrames?: number;
    coalescedFrames?: number;
    hiddenFrames?: number;
    releaseMessages?: number;
    refreshFrames?: number;
    eventQueueMs?: ReceiveStageTiming;
    videoFrameCreateMs?: ReceiveStageTiming;
    presenterWriteMs?: ReceiveStageTiming;
  };
}
const object = (
  value: unknown,
): Record<string, unknown> | undefined =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const number = (value: unknown) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0
    ? value
    : undefined;
const timing = (
  value: unknown,
): ReceiveStageTiming | undefined => {
  const v = object(value);
  if (!v) return;
  const count = number(v.count),
    totalMs = number(v.totalMs),
    maxMs = number(v.maxMs),
    windowCount = number(v.windowCount);
  if (
    count === undefined ||
    totalMs === undefined ||
    maxMs === undefined ||
    windowCount === undefined ||
    !Number.isInteger(count) ||
    !Number.isInteger(windowCount) ||
    windowCount > 256 ||
    windowCount > count
  )
    return;
  return {
    count,
    totalMs,
    maxMs,
    windowCount,
    p50Ms: number(v.p50Ms),
    p95Ms: number(v.p95Ms),
  };
};
export function readNativeReceiveStats(
  value: unknown,
): NativeReceivePipelineStats | undefined {
  const v = object(value);
  if (
    !v ||
    !(
      (v.mode === "push" && v.slots === 2) ||
      (v.mode === "gpu" && v.slots === 0)
    )
  )
    return;
  const renderer = object(v.renderer);
  return {
    mode: v.mode as "push" | "gpu",
    slots: v.slots as number,
    decodedFrames: number(v.decodedFrames),
    sharedCopies: number(v.sharedCopies),
    pushedFrames: number(v.pushedFrames),
    skippedBeforeCopy: number(v.skippedBeforeCopy),
    releasedFrames: number(v.releasedFrames),
    releaseMessages: number(v.releaseMessages),
    invalidReleases: number(v.invalidReleases),
    workerQueueMs: timing(v.workerQueueMs),
    decodedQueueMs: timing(v.decodedQueueMs),
    pixelCopyMs: timing(v.pixelCopyMs),
    leaseHoldMs: timing(v.leaseHoldMs),
    renderer: renderer
      ? {
          path:
            renderer.path === "d3d11-composition"
              ? "d3d11-composition"
              : undefined,
          presentedFrames: number(renderer.presentedFrames),
          uploadedFrames: number(renderer.uploadedFrames),
          decodedQueueMs: number(renderer.decodedQueueMs),
          submitMs: number(renderer.submitMs),
          receivedFrames: number(renderer.receivedFrames),
          submittedFrames: number(renderer.submittedFrames),
          coalescedFrames: number(renderer.coalescedFrames),
          hiddenFrames: number(renderer.hiddenFrames),
          releaseMessages: number(renderer.releaseMessages),
          refreshFrames: number(renderer.refreshFrames),
          eventQueueMs: timing(renderer.eventQueueMs),
          videoFrameCreateMs: timing(
            renderer.videoFrameCreateMs,
          ),
          presenterWriteMs: timing(
            renderer.presenterWriteMs,
          ),
        }
      : undefined,
  };
}
