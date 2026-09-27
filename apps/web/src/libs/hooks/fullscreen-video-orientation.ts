import {
  createEffect,
  onCleanup,
  type Accessor,
} from "solid-js";

type VideoOrientation = "landscape" | "portrait";
type OrientationAPI = ScreenOrientation & {
  lock?(orientation: VideoOrientation): Promise<void>;
};
const owners = new WeakMap<OrientationAPI, symbol>();

/** Best-effort orientation for the active fullscreen video, based on decoded pixels. */
export function createFullscreenVideoOrientation(
  active: Accessor<boolean>,
  videoElement: Accessor<
    HTMLVideoElement | null | undefined
  >,
) {
  createEffect(() => {
    if (!active()) return;
    const video = videoElement();
    const orientation = video?.ownerDocument.defaultView
      ?.screen.orientation as OrientationAPI | undefined;
    if (
      !video ||
      typeof orientation?.lock !== "function" ||
      typeof orientation.unlock !== "function"
    )
      return;
    const owner = Symbol();
    let live = true;
    let requested: VideoOrientation | undefined;
    const unlock = () => {
      try {
        orientation.unlock();
      } catch {
        /* Optional on this browser. */
      }
    };
    const release = () => {
      if (owners.get(orientation) !== owner) return;
      owners.delete(orientation);
      unlock();
    };
    const update = () => {
      const { videoWidth: width, videoHeight: height } =
        video;
      const next =
        width > 0 && height > 0 && width !== height
          ? width > height
            ? "landscape"
            : "portrait"
          : undefined;
      if (next === requested) return;
      requested = next;
      if (!next) {
        release();
        return;
      }
      owners.set(orientation, owner);
      try {
        void orientation.lock!(next)
          .then(() => {
            // An orientation request may resolve after Escape or tile removal.
            // Never release a newer tile's lock when an old request completes.
            if (!live && !owners.has(orientation)) unlock();
          })
          .catch(() => {
            // Unsupported/denied rotation must not reject successful fullscreen.
          });
      } catch {
        /* Some browsers expose an API that is unavailable at runtime. */
      }
    };
    video.addEventListener("loadedmetadata", update);
    video.addEventListener("resize", update);
    video.addEventListener("emptied", update);
    update();
    onCleanup(() => {
      live = false;
      video.removeEventListener("loadedmetadata", update);
      video.removeEventListener("resize", update);
      video.removeEventListener("emptied", update);
      release();
    });
  });
}
