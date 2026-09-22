export type MediaTrackKind = "audio" | "video";

export type MediaTrackContentHint =
  MediaStreamTrack["contentHint"];

export interface MediaStreamSource {
  stream: MediaStream | null | undefined;
  kind?: MediaTrackKind;
  contentHint?: MediaTrackContentHint;
}

export interface MergeMediaStreamTracksOptions {
  kind?: MediaTrackKind;
  contentHint?: MediaTrackContentHint;
}

const getTracks = (
  stream: MediaStream,
  kind?: MediaTrackKind,
): MediaStreamTrack[] => {
  const tracks = stream.getTracks();
  if (kind === undefined) return tracks;
  return tracks.filter((track) => track.kind === kind);
};

export const mergeMediaStreamTracks = (
  target: MediaStream,
  source: MediaStream | null | undefined,
  options: MergeMediaStreamTracksOptions = {},
): MediaStream => {
  if (!source) return target;

  const existingTrackIds = new Set(
    target.getTracks().map((track) => track.id),
  );

  getTracks(source, options.kind).forEach((track) => {
    if (options.contentHint !== undefined) {
      track.contentHint = options.contentHint;
    }
    if (existingTrackIds.has(track.id)) return;

    existingTrackIds.add(track.id);
    target.addTrack(track);
  });

  return target;
};

export const composeMediaStream = (
  sources: readonly MediaStreamSource[],
): MediaStream => {
  const stream = new MediaStream();

  sources.forEach((source) => {
    mergeMediaStreamTracks(stream, source.stream, {
      kind: source.kind,
      contentHint: source.contentHint,
    });
  });

  return stream;
};

/**
 * Stops every track owned by the stream and removes it from
 * the stream so observers receive the corresponding removal.
 */
export const stopMediaStream = (
  stream: MediaStream | null | undefined,
): void => {
  if (!stream) return;

  [...stream.getTracks()].forEach((track) => {
    stream.removeTrack(track);
    track.stop();
  });
};
