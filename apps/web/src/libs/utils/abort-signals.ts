/** Combine operation lifetimes without requiring Safari 17.4's AbortSignal.any. */
export function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController();
  const cleanups: (() => void)[] = [];
  const dispose = () => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  };
  for (const source of new Set(signals)) {
    if (!source) continue;
    if (source.aborted) {
      controller.abort(source.reason);
      dispose();
      break;
    }
    const abort = () => {
      controller.abort(source.reason);
      dispose();
    };
    source.addEventListener("abort", abort, { once: true });
    cleanups.push(() =>
      source.removeEventListener("abort", abort),
    );
  }
  return { signal: controller.signal, dispose };
}
