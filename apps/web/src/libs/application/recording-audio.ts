/** Bound browser permission waits, including resume() promises left pending by autoplay policy. */
function readyAudio(
  work: Promise<unknown>,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const settle = (error?: unknown) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    };
    const abort = () => settle(signal.reason);
    const timer = setTimeout(
      () =>
        settle(
          new Error(
            "Recording audio could not start; browser playback permission may be blocked",
          ),
        ),
      15000,
    );
    signal.addEventListener("abort", abort, { once: true });
    work.then(() => settle(), settle);
    if (signal.aborted) abort();
  });
}

/** Pull remote audio without audible playback, and mix only the selected source's tracks. */
export function createRecordingAudio(signal: AbortSignal) {
  const context = new AudioContext();
  // Resume synchronously in the caller's start gesture, before native-stream awaits.
  const ready = readyAudio(context.resume(), signal);
  void ready.catch(() => {});
  const output = context.createMediaStreamDestination();
  const silent = context.createGain();
  silent.gain.value = 0;
  silent.connect(context.destination);
  const inputs: MediaStreamAudioSourceNode[] = [];
  const players: HTMLAudioElement[] = [];
  let closed = false;
  return {
    ready,
    async stream(
      source: MediaStream,
    ): Promise<MediaStream> {
      const audio = source.getAudioTracks();
      if (!audio.length) return source;
      const playing: Promise<void>[] = [];
      for (const track of audio) {
        // Chromium remote audio also needs a media-element consumer even when
        // Web Audio pulls it (crbug.com/40094084). This private, muted player
        // activates decoding without changing the meeting's playback volume.
        const player = new Audio();
        player.muted = true;
        player.srcObject = new MediaStream([track]);
        players.push(player);
        playing.push(player.play());
        const input = context.createMediaStreamSource(
          new MediaStream([track]),
        );
        input.connect(output);
        input.connect(silent);
        inputs.push(input);
      }
      await readyAudio(Promise.all(playing), signal);
      return new MediaStream([
        ...source.getVideoTracks(),
        ...output.stream.getAudioTracks(),
      ]);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const player of players) {
        player.pause();
        player.srcObject = null;
        player.load();
      }
      inputs.forEach((input) => input.disconnect());
      silent.disconnect();
      output.stream
        .getTracks()
        .forEach((track) => track.stop());
      void context.close().catch(() => {});
    },
  };
}
