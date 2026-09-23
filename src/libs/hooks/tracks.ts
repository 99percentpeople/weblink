import {
  Accessor,
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";

export const createMediaTracks = (
  mediaStream: Accessor<MediaStream | null>,
) => {
  const [tracks, setTracks] = createSignal<
    MediaStreamTrack[]
  >(mediaStream()?.getTracks() ?? []);

  createEffect(() => {
    const stream = mediaStream();

    if (!stream) {
      setTracks([]);
      return;
    }

    const controller = new AbortController();
    const observed = new WeakSet<MediaStreamTrack>();
    const refresh = () => {
      const current = stream
        .getTracks()
        .filter((track) => track.readyState !== "ended");
      current.forEach((track) => {
        if (observed.has(track)) return;
        observed.add(track);
        track.addEventListener("ended", refresh, {
          signal: controller.signal,
        });
      });
      setTracks(current);
    };
    onCleanup(() => controller.abort());
    stream.addEventListener("addtrack", refresh, {
      signal: controller.signal,
    });
    stream.addEventListener("removetrack", refresh, {
      signal: controller.signal,
    });
    refresh();
  });

  return tracks;
};
