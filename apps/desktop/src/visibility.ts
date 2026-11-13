import { watchStatus } from "./status-watch";
import { EventBus } from "@weblink/platform/events";
import { SubscriptionScope } from "@weblink/platform/subscription-scope";

/** One native channel per adapter, released when the last view stops observing. */
export function createVisibilityWatcher(
  watch: (
    receive: (visible: boolean) => void,
  ) => Promise<() => void> = (receive) =>
    watchStatus("application_visibility", {}, receive),
): (receive: (visible: boolean) => void) => () => void {
  const bus = new EventBus<{ changed: boolean }>(
    "window.visibility",
  );
  let current: boolean | undefined;
  let generation = 0;
  let subscriptions = new SubscriptionScope();
  let retry: ReturnType<typeof setTimeout> | undefined;
  const start = async (token: number) => {
    const scope = subscriptions;
    try {
      await scope.track(
        watch((visible) => {
          if (token !== generation) return;
          current = visible;
          bus.emit("changed", visible);
        }),
      );
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
    const stop = bus.subscribe("changed", receive);
    let active = true;
    if (current !== undefined) receive(current);
    if (bus.listenerCount === 1) void start(generation);
    return () => {
      if (!active) return;
      active = false;
      stop();
      if (bus.listenerCount) return;
      ++generation;
      clearTimeout(retry);
      subscriptions.dispose();
      subscriptions = new SubscriptionScope();
      current = undefined;
    };
  };
}
