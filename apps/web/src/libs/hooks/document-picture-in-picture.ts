import { createSignal, onCleanup } from "solid-js";

export interface DocumentPictureInPictureAPI {
  requestWindow(options: {
    width: number;
    height: number;
  }): Promise<Window>;
}

/** Owns a window, never the media displayed inside it. */
export function createDocumentPictureInPicture(options: {
  api?: DocumentPictureInPictureAPI;
  onError(error: unknown): void;
  onClose?(): void;
}) {
  const [pipWindow, setPipWindow] = createSignal<Window>();
  const [busy, setBusy] = createSignal(false);
  let pending: Promise<void> | undefined;
  let generation = 0;
  let disposed = false;
  let detach: (() => void) | undefined;
  const supported = () =>
    typeof options.api?.requestWindow === "function";

  const close = () => {
    generation++;
    const current = pipWindow();
    detach?.();
    detach = undefined;
    // Dispose the Solid portal while its document is still available.
    setPipWindow(undefined);
    current?.close();
  };
  const open = (): Promise<void> => {
    if (disposed || !supported() || !options.api)
      return Promise.resolve();
    if (pipWindow() && !pipWindow()!.closed)
      return Promise.resolve();
    if (pending) return pending;
    const request = ++generation;
    setBusy(true);
    let result: Promise<Window>;
    try {
      // Invoke synchronously in the click/navigation/media-session handler.
      result = options.api.requestWindow({
        width: 480,
        height: 350,
      });
    } catch (error) {
      setBusy(false);
      options.onError(error);
      return Promise.resolve();
    }
    pending = result
      .then((window) => {
        if (disposed || request !== generation) {
          window.close();
          return;
        }
        const closed = () => {
          if (pipWindow() !== window) return;
          detach?.();
          detach = undefined;
          setPipWindow(undefined);
          options.onClose?.();
        };
        window.addEventListener("pagehide", closed, {
          once: true,
        });
        detach = () =>
          window.removeEventListener("pagehide", closed);
        setPipWindow(window);
      })
      .catch((error: unknown) => {
        if (!disposed && request === generation) {
          close();
          options.onError(error);
        }
      })
      .finally(() => {
        pending = undefined;
        if (!disposed) setBusy(false);
      });
    return pending;
  };
  onCleanup(() => {
    disposed = true;
    close();
  });
  return {
    window: pipWindow,
    supported,
    active: () => Boolean(pipWindow()),
    busy,
    open,
    close,
  };
}
