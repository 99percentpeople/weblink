// Native audio/video ownership comes from each media connection. Track IDs are
// not a cross-peer mapping, and the aggregate stream may contain many screens.
const owners = new WeakMap<
  MediaStreamTrack,
  MediaStreamTrack | null
>();
export function bindNativeScreenAudio(
  stream: MediaStream,
): void {
  const video = stream.getVideoTracks()[0];
  // Audio can arrive before video. Mark it as belonging to this connection
  // immediately so a different, already visible screen cannot claim it.
  for (const audio of stream.getAudioTracks())
    owners.set(audio, video ?? null);
}
export const getNativeScreenAudioOwner = (
  track: MediaStreamTrack,
) => owners.get(track);
