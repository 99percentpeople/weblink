import {
  batch,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type { NativeApplication } from "@weblink/platform";

/** Native startup preferences outlive settings views and pending writes. */
export function createAppStartup(
  startup: NativeApplication["autostart"],
) {
  const [enabled, setEnabled] = createSignal<boolean>();
  const [behavior, setBehavior] = createSignal<
    "tray" | "window"
  >("tray");
  const [busy, setBusy] = createSignal(false);
  const [failed, setFailed] = createSignal(false);
  let disposed = false;
  let revision = 0;
  let pending: Promise<void> | undefined;

  const refresh = (): Promise<void> => {
    if (disposed || !startup || busy())
      return Promise.resolve();
    if (pending) return pending;
    const token = revision;
    pending = Promise.resolve()
      .then(() =>
        Promise.all([
          startup.enabled(),
          startup.behavior(),
        ]),
      )
      .then(([nextEnabled, nextBehavior]) => {
        if (disposed || token !== revision) return;
        batch(() => {
          setEnabled(nextEnabled);
          setBehavior(nextBehavior);
          setFailed(false);
        });
      })
      .catch(() => {
        if (!disposed && token === revision)
          setFailed(true);
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };

  const update = async (
    write: () => Promise<() => void>,
  ): Promise<void> => {
    if (
      disposed ||
      !startup ||
      busy() ||
      enabled() === undefined
    )
      return;
    ++revision;
    setBusy(true);
    setFailed(false);
    try {
      const apply = await write();
      if (!disposed) apply();
    } catch {
      if (!disposed) setFailed(true);
    } finally {
      if (!disposed) setBusy(false);
    }
  };

  onMount(() => {
    if (!startup) return;
    void refresh();
    const listener = new AbortController();
    window.addEventListener("focus", () => void refresh(), {
      signal: listener.signal,
    });
    onCleanup(() => listener.abort());
  });
  onCleanup(() => {
    disposed = true;
  });

  return {
    supported: !!startup,
    enabled,
    behavior,
    busy,
    failed,
    refresh,
    setEnabled: (value: boolean) =>
      update(async () => {
        const actual = await startup!.setEnabled(value);
        return () => setEnabled(actual);
      }),
    setBehavior: (value: "tray" | "window") =>
      update(async () => {
        await startup!.setBehavior(value);
        return () => setBehavior(value);
      }),
  };
}

export type AppStartup = ReturnType<
  typeof createAppStartup
>;
