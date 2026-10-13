import { createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import type {
  NativeUpdateCheck,
  NativeUpdateInfo,
  NativeUpdateProgress,
  NativeUpdates,
} from "@weblink/platform";

/** One owner for startup checks, settings checks, and installs across view remounts. */
export function createAppUpdates(native: NativeUpdates) {
  const [result, setResult] =
    createSignal<NativeUpdateCheck>();
  const [pending, setPending] = createSignal<
    "check" | "install" | null
  >(null);
  const [error, setError] = createSignal<
    "check" | "install" | null
  >(null);
  const [progress, setProgress] =
    createSignal<NativeUpdateProgress>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  const update = () => {
    const current = result();
    return current?.status === "available"
      ? current.update
      : undefined;
  };
  const unavailableReason = () => {
    const current = result();
    return current?.status === "unavailable"
      ? current.reason
      : undefined;
  };
  const percent = () => {
    const value = progress();
    return value?.total
      ? Math.min(
          100,
          Math.floor(
            (value.downloaded / value.total) * 100,
          ),
        )
      : undefined;
  };
  let checkPromise:
    | Promise<NativeUpdateCheck | undefined>
    | undefined;
  const check = (): Promise<
    NativeUpdateCheck | undefined
  > => {
    if (checkPromise) return checkPromise;
    if (disposed || pending())
      return Promise.resolve(undefined);
    checkPromise = runCheck().finally(() => {
      checkPromise = undefined;
    });
    return checkPromise;
  };
  const runCheck = async () => {
    setPending("check");
    setError(null);
    setResult(undefined);
    try {
      const checked = await native.check();
      if (!disposed) setResult(checked);
      return disposed ? undefined : checked;
    } catch {
      if (!disposed) setError("check");
    } finally {
      if (!disposed) setPending(null);
    }
  };
  const install = async () => {
    const available = update();
    if (disposed || pending() || !available?.canInstall)
      return;
    setPending("install");
    setError(null);
    setProgress({
      phase: "downloading",
      downloaded: 0,
      total: null,
    });
    try {
      await native.install(available.version, (value) => {
        if (!disposed) setProgress(value);
      });
      // Windows exits after launching the installer. Keep actions disabled.
    } catch {
      if (!disposed) {
        setError("install");
        setProgress(undefined);
        setPending(null);
      }
    }
  };

  let startupChecked = false;
  const [startupUpdate, setStartupUpdate] =
    createSignal<NativeUpdateInfo>();
  const checkOnStartup = async (
    enabled: Accessor<boolean>,
  ) => {
    if (startupChecked || disposed) return;
    startupChecked = true;
    if (!enabled()) return;
    const checked = await check();
    if (
      !disposed &&
      enabled() &&
      checked?.status === "available"
    ) {
      setStartupUpdate(checked.update);
    }
  };
  return {
    result,
    pending,
    error,
    progress,
    update,
    unavailableReason,
    percent,
    check,
    install,
    startupUpdate,
    checkOnStartup,
  };
}
export type AppUpdates = ReturnType<
  typeof createAppUpdates
>;
