import {
  createSignal,
  createEffect,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";

type WebKitVideo = HTMLVideoElement & {
  webkitSupportsPresentationMode?(mode: string): boolean;
  webkitSetPresentationMode?(mode: string): void;
  webkitPresentationMode?: string;
};

function presentationAPI(video: WebKitVideo) {
  // WebKit may expose the standard API even when this video/context cannot
  // enter PiP (for example some installed web apps). Respect its actual probe.
  if (
    typeof video.webkitSupportsPresentationMode ===
    "function"
  ) {
    try {
      if (
        !video.webkitSupportsPresentationMode(
          "picture-in-picture",
        )
      )
        return;
    } catch {
      return;
    }
  }
  if (
    video.ownerDocument.pictureInPictureEnabled &&
    typeof video.requestPictureInPicture === "function" &&
    typeof video.ownerDocument.exitPictureInPicture ===
      "function"
  )
    return "standard";
  if (
    typeof video.webkitSupportsPresentationMode ===
      "function" &&
    typeof video.webkitSetPresentationMode === "function"
  )
    return "webkit";
}

/** Owns the presentation mode only; never stops the underlying media tracks. */
export function createPictureInPicture(
  videoElement: Accessor<
    HTMLVideoElement | null | undefined
  >,
  options: {
    onError?(error: unknown): void;
    onClose?(): void;
  } = {},
) {
  const [supported, setSupported] = createSignal(false);
  const [ready, setReady] = createSignal(false);
  const [active, setActive] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  let generation = 0;
  let disposed = false;
  let pending: Promise<void> | undefined;
  const owns = (video: WebKitVideo) =>
    video.ownerDocument.pictureInPictureElement === video ||
    video.webkitPresentationMode === "picture-in-picture";
  const sync = () => {
    const video = videoElement() as
      | WebKitVideo
      | null
      | undefined;
    setSupported(Boolean(video && presentationAPI(video)));
    setReady(
      Boolean(
        video &&
        video.readyState >=
          HTMLMediaElement.HAVE_METADATA &&
        video.videoWidth > 0,
      ),
    );
    const wasActive = active();
    const nowActive = Boolean(video && owns(video));
    setActive(nowActive);
    if (wasActive && !nowActive) options.onClose?.();
  };
  const exitOwned = async (
    video: WebKitVideo | null | undefined,
  ) => {
    if (!video || !owns(video)) return;
    try {
      if (
        video.ownerDocument.pictureInPictureElement ===
        video
      ) {
        await video.ownerDocument.exitPictureInPicture();
      } else {
        video.webkitSetPresentationMode?.("inline");
      }
    } catch (error) {
      if (!disposed) options.onError?.(error);
    }
    if (!disposed) sync();
  };
  const exitPictureInPicture = () => {
    generation++;
    return exitOwned(videoElement());
  };
  const requestPictureInPicture = (): Promise<void> => {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    sync();
    const video = videoElement() as
      | WebKitVideo
      | null
      | undefined;
    if (!video || !supported() || !ready() || owns(video))
      return Promise.resolve();
    const request = ++generation;
    setBusy(true);
    let result: Promise<unknown> | void = undefined;
    try {
      // Keep this call in the original user gesture; do not await play/metadata.
      if (presentationAPI(video) === "standard")
        result = video.requestPictureInPicture();
      else
        video.webkitSetPresentationMode?.(
          "picture-in-picture",
        );
    } catch (error) {
      setBusy(false);
      options.onError?.(error);
      return Promise.resolve();
    }
    pending = Promise.resolve(result)
      .then(async () => {
        if (
          disposed ||
          request !== generation ||
          videoElement() !== video
        ) {
          await exitOwned(video);
          return;
        }
        sync();
      })
      .catch((error: unknown) => {
        if (!disposed && request === generation)
          options.onError?.(error);
      })
      .finally(() => {
        pending = undefined;
        if (!disposed) setBusy(false);
      });
    return pending;
  };
  createEffect(() => {
    const video = videoElement();
    // Read active outside tracking so events do not reinstall listeners.
    if (!video) {
      setSupported(false);
      setReady(false);
      setActive(false);
      return;
    }
    const events = [
      "loadedmetadata",
      "emptied",
      "resize",
      "enterpictureinpicture",
      "leavepictureinpicture",
      "webkitpresentationmodechanged",
    ];
    events.forEach((event) =>
      video.addEventListener(event, sync),
    );
    // sync reads reactive state; it must not subscribe this lifetime effect.
    untrack(sync);
    onCleanup(() => {
      generation++;
      events.forEach((event) =>
        video.removeEventListener(event, sync),
      );
      void exitOwned(video);
    });
  });
  onCleanup(() => {
    disposed = true;
    generation++;
  });
  return {
    isSupported: supported,
    isReady: ready,
    isBusy: busy,
    isInPip: () =>
      active() ||
      Boolean(
        videoElement()?.ownerDocument
          .pictureInPictureElement,
      ),
    isThisElementInPip: active,
    requestPictureInPicture,
    exitPictureInPicture,
  };
}
