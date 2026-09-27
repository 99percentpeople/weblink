import {
  createEffect,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";

/** Start/resume borrowed video only once its presentation is visible. */
export function createVideoPlaybackRecovery(options: {
  video: Accessor<HTMLVideoElement | null>;
  track: Accessor<MediaStreamTrack | null>;
  active: Accessor<boolean>;
  resume(
    video: HTMLVideoElement,
    track: MediaStreamTrack,
  ): void;
}): void {
  createEffect(
    on([options.video, options.track], ([video, track]) => {
      if (!video || !track) return;
      const target = video.ownerDocument;
      const events = new AbortController();
      const Observer =
        target.defaultView?.IntersectionObserver;
      // Wait for the browser's first layout before attaching a new source.
      // A muted MediaStream attached to a hidden Safari video may decode for
      // native PiP while its inline presentation remains black.
      let inViewport = !Observer;
      let wasVisible = false;
      const resume = (force = false) => {
        if (
          events.signal.aborted ||
          !options.active() ||
          !inViewport ||
          target.visibilityState === "hidden" ||
          !video.isConnected ||
          track.readyState === "ended" ||
          target.defaultView?.getComputedStyle(video)
            .visibility === "hidden"
        ) {
          wasVisible = false;
          return;
        }
        const revealed = !wasVisible;
        wasVisible = true;
        // Visibility and presentation changes can leave WebKit's inline layer
        // stale even when paused is false. Reissue play once, without replacing
        // the element/stream or disrupting a healthy video on every media event.
        if (
          video.ended ||
          (video.srcObject &&
            !video.paused &&
            !revealed &&
            !force)
        )
          return;
        options.resume(video, track);
      };
      const recover = () => resume();
      const presentationChanged = () =>
        queueMicrotask(() => resume(true));
      const listener = { signal: events.signal };
      // A later unmute matters too: remote tracks can survive many interruptions.
      track.addEventListener("unmute", recover, listener);
      video.addEventListener(
        "loadedmetadata",
        recover,
        listener,
      );
      video.addEventListener("canplay", recover, listener);
      for (const event of [
        "leavepictureinpicture",
        "webkitpresentationmodechanged",
        "webkitendfullscreen",
        "resize",
      ]) {
        video.addEventListener(
          event,
          presentationChanged,
          listener,
        );
      }
      target.addEventListener(
        "visibilitychange",
        recover,
        listener,
      );
      target.defaultView?.addEventListener(
        "pageshow",
        recover,
        listener,
      );
      target.defaultView?.addEventListener(
        "focus",
        recover,
        listener,
      );
      const observer = Observer
        ? new Observer((entries) => {
            for (const entry of entries) {
              if (entry.target !== video) continue;
              inViewport = entry.isIntersecting;
              resume();
            }
          })
        : undefined;
      observer?.observe(video);
      // CSS visibility (the full-width sidebar) can leave intersection unchanged.
      createEffect(
        on(
          options.active,
          (active) => {
            if (!active) wasVisible = false;
            // Solid may still be committing the stage's visibility classes.
            else queueMicrotask(recover);
          },
          { defer: true },
        ),
      );
      if (!Observer) queueMicrotask(recover);
      onCleanup(() => {
        events.abort();
        observer?.disconnect();
      });
    }),
  );
}
