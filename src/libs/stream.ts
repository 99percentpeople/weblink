import {
  createEffect,
  createRoot,
  createSignal,
  untrack,
} from "solid-js";

type TrackKind = MediaStreamTrack["kind"];
type TrackContentHint = MediaStreamTrack["contentHint"];

type StreamSource = {
  stream: MediaStream | null | undefined;
  kind?: TrackKind;
  contentHint?: TrackContentHint;
};

const getTracksByKind = (
  stream: MediaStream,
  kind?: TrackKind,
) => {
  if (kind === undefined) return stream.getTracks();
  return stream
    .getTracks()
    .filter((track) => track.kind === kind);
};

const applyContentHint = (
  track: MediaStreamTrack,
  contentHint?: TrackContentHint,
) => {
  if (contentHint === undefined) return;
  track.contentHint = contentHint;
};

export const mergeMediaStreamTracks = (
  target: MediaStream,
  source: MediaStream | null | undefined,
  options: {
    kind?: TrackKind;
    contentHint?: TrackContentHint;
  } = {},
) => {
  if (source === null || source === undefined) {
    return target;
  }

  const existingTrackIds = new Set(
    target.getTracks().map((track) => track.id),
  );

  getTracksByKind(source, options.kind).forEach((track) => {
    applyContentHint(track, options.contentHint);
    if (existingTrackIds.has(track.id)) return;
    existingTrackIds.add(track.id);
    target.addTrack(track);
  });

  return target;
};

export const createLocalMediaStream = (
  sources: StreamSource[],
) => {
  const stream = new MediaStream();

  sources.forEach((source) => {
    mergeMediaStreamTracks(stream, source.stream, {
      kind: source.kind,
      contentHint: source.contentHint,
    });
  });

  return stream;
};

export const stopMediaStream = (
  stream: MediaStream | null | undefined,
) => {
  if (stream === null || stream === undefined) return;

  [...stream.getTracks()].forEach((track) => {
    stream.removeTrack(track);
    track.stop();
  });
};

const [localStream, setLocalStream] =
  createSignal<MediaStream | null>(null);

const [displayStream, setDisplayStream] =
  createSignal<MediaStream | null>();

createRoot(() => {
  createEffect<AbortController | undefined>((prev) => {
    const currentStream = untrack(localStream);
    const display = displayStream();
    if (currentStream?.id === display?.id) return prev;

    prev?.abort();

    if (currentStream) {
      stopMediaStream(currentStream);
      setLocalStream(null);
    }

    if (!display) return;

    const controller = new AbortController();
    display.getTracks().forEach((track) => {
      track.addEventListener(
        "ended",
        () => {
          console.log(
            `display stream remove track`,
            track.id,
          );
          display.removeTrack(track);

          if (display.getTracks().length === 0) {
            setLocalStream(null);
          }
        },
        { signal: controller.signal },
      );
    });

    setLocalStream(display);
    return controller;
  });
});

export { localStream, setDisplayStream };
