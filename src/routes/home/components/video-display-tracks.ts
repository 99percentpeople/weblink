export const getVisibleVideoDisplayTracks = (
  tracks: readonly MediaStreamTrack[],
  isPlaceholderStream: boolean,
): MediaStreamTrack[] => {
  if (!isPlaceholderStream) return [...tracks];
  return tracks.filter((track) => track.kind !== "video");
};
