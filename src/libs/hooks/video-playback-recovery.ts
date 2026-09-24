import {
  createEffect,
  on,
  onCleanup,
  type Accessor,
} from "solid-js";

/** Resume a borrowed live video after browser or layout visibility changes. */
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
      let inViewport = true;
      const resume = () => {
        if (
          events.signal.aborted ||
          !options.active() ||
          !inViewport ||
          target.visibilityState === "hidden" ||
          !video.isConnected ||
          !video.srcObject ||
          track.readyState === "ended" ||
          !video.paused ||
          video.ended
        )
          return;
        options.resume(video, track);
      };
      const listener = { signal: events.signal };
      // A later unmute matters too: remote tracks can survive many interruptions.
      track.addEventListener("unmute", resume, listener);
      video.addEventListener(
        "loadedmetadata",
        resume,
        listener,
      );
      video.addEventListener("canplay", resume, listener);
      target.addEventListener(
        "visibilitychange",
        resume,
        listener,
      );
      target.defaultView?.addEventListener(
        "pageshow",
        resume,
        listener,
      );
      target.defaultView?.addEventListener(
        "focus",
        resume,
        listener,
      );
      const Observer =
        target.defaultView?.IntersectionObserver;
      const observer = Observer
        ? new Observer((entries) => {
            for (const entry of entries) {
              if (entry.target !== video) continue;
              inViewport = entry.isIntersecting;
              if (inViewport) resume();
            }
          })
        : undefined;
      observer?.observe(video);
      // CSS visibility (the full-width sidebar) can leave intersection unchanged.
      createEffect(
        on(
          options.active,
          (active) => {
            if (active) resume();
          },
          { defer: true },
        ),
      );
      onCleanup(() => {
        events.abort();
        observer?.disconnect();
      });
    }),
  );
}
