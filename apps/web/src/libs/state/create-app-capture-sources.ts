import {
  createEffect,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  CaptureSource,
  NativeCapture,
} from "@weblink/platform";

/** Discovery is shared; starting and stopping a diagnostic capture stays view-owned. */
export function createAppCaptureSources(options: {
  capture: Pick<NativeCapture, "sources"> | undefined;
  supported: Accessor<boolean>;
}) {
  const [sources, setSources] = createSignal<
    CaptureSource[]
  >([]);
  const [refreshing, setRefreshing] = createSignal(false);
  const [error, setError] = createSignal<string>();
  let disposed = false;
  let generation = 0;
  let pending: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    const capture = options.capture;
    if (disposed || !capture || !options.supported())
      return Promise.resolve();
    if (pending) return pending;
    const token = generation;
    const current = () => !disposed && token === generation;
    setRefreshing(true);
    pending = Promise.resolve()
      .then(() => (current() ? capture.sources() : []))
      .then((next) => {
        if (!current()) return;
        setSources(next);
        setError(undefined);
      })
      .catch((cause: unknown) => {
        if (current())
          setError(
            cause instanceof Error
              ? cause.message
              : String(cause),
          );
      })
      .finally(() => {
        if (current()) {
          pending = undefined;
          setRefreshing(false);
        }
      });
    return pending;
  };

  createEffect(() => {
    const supported = options.supported();
    untrack(() => {
      if (supported) {
        void refresh();
      } else {
        ++generation;
        pending = undefined;
        setSources([]);
        setError(undefined);
        setRefreshing(false);
      }
    });
  });
  onMount(() => {
    if (!options.capture) return;
    const listener = new AbortController();
    window.addEventListener("focus", () => void refresh(), {
      signal: listener.signal,
    });
    onCleanup(() => listener.abort());
  });
  onCleanup(() => {
    disposed = true;
  });

  return { sources, refreshing, error, refresh };
}

export type AppCaptureSources = ReturnType<
  typeof createAppCaptureSources
>;
