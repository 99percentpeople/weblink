import {
  createEffect,
  createSignal,
  untrack,
} from "solid-js";

const [streamLocal, setLocalStream] =
  createSignal<MediaStream | null>(null);

export const localStream = streamLocal;

export const [displayStream, setDisplayStream] =
  createSignal<MediaStream | null>();

createEffect(() => {
  const currentStream = untrack(localStream);
  if (currentStream) {
    currentStream.getTracks().forEach((track) => {
      track.stop();
      currentStream.removeTrack(track);
    });

    setLocalStream(null);
  }

  const display = displayStream();
  if (display) {
    display.getAudioTracks().forEach((track) => {
      track.contentHint = "music";
    });
    display.getVideoTracks().forEach((track) => {
      track.contentHint = "motion";
    });

    const stream = new MediaStream();
    display.getTracks().forEach((track) => {
      stream.addTrack(track);

      track.addEventListener("ended", () => {
        stream.removeTrack(track);
        if (stream.getTracks().length === 0) {
          setLocalStream(null);
        }
      });
    });
    setLocalStream(stream);
  }
});
