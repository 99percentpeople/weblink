import {
  createSignal,
  createEffect,
  onCleanup,
  Accessor,
} from "solid-js";

type CreateFullscreenResult = {
  isSupported: Accessor<boolean>;
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

  const requestFullscreen = async () => {
    const el = element();
    if (!el) return;
    if (!isSupported()) {
      console.warn(
        "Current browser does not support fullscreen mode.",
      );
      return;
    }
    try {
      if (el.requestFullscreen)
        await el.requestFullscreen();
      else if ((el as any).webkitRequestFullscreen)
        (el as any).webkitRequestFullscreen();
    } catch (error) {
      console.error(
        "Request to enter fullscreen failed:",
        error,
      );
    }
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
  const exitFullscreen = () =>
    exitOwnedFullscreen(element());

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
      void exitOwnedFullscreen(owned);
    });
  });

  return {
    isSupported,
    isFullscreen,
    isThisElementFullscreen,
    requestFullscreen,
    exitFullscreen,
  };
}
