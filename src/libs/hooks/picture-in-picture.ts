import {
  createSignal,
  createEffect,
  onCleanup,
  Accessor,
} from "solid-js";

type CreatePictureInPictureResult = {
  isSupported: Accessor<boolean>;
  isInPip: Accessor<boolean>;
  isThisElementInPip: Accessor<boolean>;
  requestPictureInPicture: () => Promise<void>;
  exitPictureInPicture: () => Promise<void>;
};

const [currentPipElement, setCurrentPipElement] =
  createSignal<HTMLVideoElement | null>(
    (document.pictureInPictureElement as HTMLVideoElement | null) ??
      null,
  );
const [isSupported] = createSignal(
  typeof document !== "undefined" &&
    "pictureInPictureEnabled" in document
    ? document.pictureInPictureEnabled
    : false,
);

export function createPictureInPicture(
  videoElement: Accessor<
    HTMLVideoElement | null | undefined
  >,
): CreatePictureInPictureResult {
  const syncCurrentElement = () =>
    setCurrentPipElement(
      (document.pictureInPictureElement as HTMLVideoElement | null) ??
        null,
    );
  const isInPip = () => currentPipElement() !== null;
  const isThisElementInPip = () => {
    const current = videoElement();
    return Boolean(
      current && currentPipElement() === current,
    );
  };

  const requestPictureInPicture = async () => {
    const video = videoElement();
    if (!video) return;
    if (!isSupported()) {
      console.warn(
        "This browser does not support picture-in-picture.",
      );
      return;
    }
    try {
      await video.requestPictureInPicture();
    } catch (error) {
      console.error(
        "Request to enter picture-in-picture failed:",
        error,
      );
    }
  };

  const exitOwnedPictureInPicture = async (
    owned: HTMLVideoElement | null | undefined,
  ) => {
    if (
      !owned ||
      document.pictureInPictureElement !== owned
    )
      return;
    try {
      await document.exitPictureInPicture();
      syncCurrentElement();
    } catch (error) {
      console.error(
        "Failed to exit picture-in-picture:",
        error,
      );
    }
  };
  const exitPictureInPicture = () =>
    exitOwnedPictureInPicture(videoElement());

  createEffect(() => {
    const owned = videoElement();
    syncCurrentElement();
    if (!owned || !isSupported()) return;
    owned.addEventListener(
      "enterpictureinpicture",
      syncCurrentElement,
    );
    owned.addEventListener(
      "leavepictureinpicture",
      syncCurrentElement,
    );
    onCleanup(() => {
      owned.removeEventListener(
        "enterpictureinpicture",
        syncCurrentElement,
      );
      owned.removeEventListener(
        "leavepictureinpicture",
        syncCurrentElement,
      );
      void exitOwnedPictureInPicture(owned);
    });
  });

  return {
    isSupported,
    isInPip,
    isThisElementInPip,
    requestPictureInPicture,
    exitPictureInPicture,
  };
}
