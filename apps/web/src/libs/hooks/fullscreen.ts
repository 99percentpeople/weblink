import {
  createSignal,
  createEffect,
  onCleanup,
  Accessor,
} from "solid-js";

type CreateFullscreenResult = {
  isSupported: Accessor<boolean>;
  isBusy: Accessor<boolean>;
  isFullscreen: Accessor<boolean>;
  isThisElementFullscreen: Accessor<boolean>;
  requestFullscreen: () => Promise<void>;
  exitFullscreen: () => Promise<void>;
};

const [
  currentFullscreenElement,
  setCurrentFullscreenElement,
] = createSignal<HTMLElement | null>(
  (document.fullscreenElement as HTMLElement | null) ??
    null,
);
const [isSupported] = createSignal(
  typeof document !== "undefined" &&
    "fullscreenEnabled" in document
    ? document.fullscreenEnabled
    : false,
);

export function createFullscreen(
  element: Accessor<HTMLElement | null | undefined>,
): CreateFullscreenResult {
  const [busy, setBusy] = createSignal(false);
  let pending: Promise<void> | undefined;
  let generation = 0;
  let disposed = false;
  const onFullscreenChange = () => {
    setCurrentFullscreenElement(
      (document.fullscreenElement as HTMLElement | null) ??
        null,
    );
  };
  const isFullscreen = () =>
    currentFullscreenElement() !== null;
  const isThisElementFullscreen = () => {
    const current = element();
    return Boolean(
      current && currentFullscreenElement() === current,
    );
  };

  const exitOwnedFullscreen = async (
    owned: HTMLElement | null | undefined,
  ) => {
    if (!owned || document.fullscreenElement !== owned)
      return;
    try {
      await document.exitFullscreen();
      onFullscreenChange();
    } catch (error) {
      console.error("Exit fullscreen failed:", error);
    }
  };
  const requestFullscreen = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const el = element();
    if (!el || !isSupported()) return Promise.resolve();
    const request = ++generation;
    setBusy(true);
    let result: Promise<void> | void;
    try {
      // Request synchronously, preserving the browser's user activation.
      if (el.requestFullscreen)
        result = el.requestFullscreen();
      else
        result = (
          el as HTMLElement & {
            webkitRequestFullscreen?(): void;
          }
        ).webkitRequestFullscreen?.();
    } catch (error) {
      setBusy(false);
      console.error(
        "Request to enter fullscreen failed:",
        error,
      );
      return Promise.resolve();
    }
    pending = Promise.resolve(result)
      .then(async () => {
        if (
          disposed ||
          request !== generation ||
          element() !== el
        )
          await exitOwnedFullscreen(el);
        else onFullscreenChange();
      })
      .catch((error: unknown) => {
        if (!disposed)
          console.error(
            "Request to enter fullscreen failed:",
            error,
          );
      })
      .finally(() => {
        pending = undefined;
        if (!disposed) setBusy(false);
      });
    return pending;
  };
  const exitFullscreen = async () => {
    generation++;
    const owned = element();
    if (pending) await pending;
    await exitOwnedFullscreen(owned);
  };

  if (typeof document !== "undefined") {
    document.addEventListener(
      "fullscreenchange",
      onFullscreenChange,
    );
    onFullscreenChange();
    onCleanup(() =>
      document.removeEventListener(
        "fullscreenchange",
        onFullscreenChange,
      ),
    );
  }
  createEffect(() => {
    const owned = element();
    // The captured old element remains available when its ref becomes null or
    // changes to another source. Cleanup must never exit another tile's mode.
    onCleanup(() => {
      generation++;
      void exitOwnedFullscreen(owned);
    });
  });

  onCleanup(() => {
    disposed = true;
    generation++;
  });
  return {
    isSupported,
    isBusy: busy,
    isFullscreen,
    isThisElementFullscreen,
    requestFullscreen,
    exitFullscreen,
  };
}
