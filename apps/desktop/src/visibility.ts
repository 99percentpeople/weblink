import { watchStatus } from "./status-watch";

/** One native channel per adapter, released when the last view stops observing. */
export function createVisibilityWatcher(
  watch: (
    receive: (visible: boolean) => void,
  ) => Promise<() => void> = (receive) =>
    watchStatus("application_visibility", {}, receive),
): (receive: (visible: boolean) => void) => () => void {
  const listeners = new Set<(visible: boolean) => void>();
  let current: boolean | undefined;
  let generation = 0;
  let unwatch: (() => void) | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const start = async (token: number) => {
    try {
      const dispose = await watch((visible) => {
        if (token !== generation) return;
        current = visible;
        for (const receive of listeners) receive(visible);
      });
      if (token !== generation) dispose();
      else unwatch = dispose;
    } catch (error) {
      if (token !== generation) return;
      console.warn(
        "Could not watch window visibility",
        error,
      );
      retry = setTimeout(() => void start(token), 1000);
    }
  };
  return (receive) => {
    // Each registration has its own lifetime even if callbacks are identical.
    const listener = (visible: boolean) => receive(visible);
    listeners.add(listener);
    if (current !== undefined) receive(current);
    if (listeners.size === 1) void start(generation);
    return () => {
      if (!listeners.delete(listener) || listeners.size)
        return;
      ++generation;
      clearTimeout(retry);
      unwatch?.();
      unwatch = undefined;
      current = undefined;
    };
  };
}
