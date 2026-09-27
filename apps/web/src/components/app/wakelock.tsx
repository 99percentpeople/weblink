import { catchError } from "@/libs/catch";
import {
  createSignal,
  onMount,
  onCleanup,
  createEffect,
} from "solid-js";

export const AppWakeLock = (props: {
  enabled: boolean;
}) => {
  const [wakeLock, setWakeLock] =
    createSignal<WakeLockSentinel | null>(null);

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator)) {
      console.warn("Wake Lock API is not supported");
      return;
    }
    const lock = wakeLock();
    if (lock && lock.released === false) {
      return;
    }

    const [err, newLock] = await catchError(
      navigator.wakeLock.request("screen"),
    );
    if (err) {
      if (err.name !== "NotAllowedError")
        console.error(err);
      return;
    }
    setWakeLock(newLock);
    newLock.addEventListener("release", () => {
      setWakeLock(null);
    });
  };
  const handleVisibilityChange = async () => {
    if (
      document.visibilityState === "visible" &&
      props.enabled
    ) {
      await requestWakeLock();
    }
  };

  createEffect(() => {
    if (props.enabled) {
      requestWakeLock();
    }
  });

  onMount(async () => {
    document.addEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );
  });

  onCleanup(() => {
    document.removeEventListener(
      "visibilitychange",
      handleVisibilityChange,
    );
    wakeLock()?.release();
  });
  return <></>;
};
