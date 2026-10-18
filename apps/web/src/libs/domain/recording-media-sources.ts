import type {
  EncodedMediaSource,
  EncodedMediaSubscription,
} from "./encoded-video";

/** Pair only the selected tracks from one connection; never borrow another peer's audio. */
export function recordingMediaSources(
  video: EncodedMediaSource | undefined,
  audio: readonly (EncodedMediaSource | undefined)[],
): EncodedMediaSource[] {
  if (!video) return [];
  // Multiple audio tracks require the established mix; encoded packets cannot be mixed.
  if (audio.length !== 1 || !audio[0]) return [video];
  const sound = audio[0];
  return [
    {
      encodedAudio: true,
      async subscribe(consumer, signal) {
        const subscriptions: EncodedMediaSubscription[] =
          [];
        try {
          for (const source of [video, sound]) {
            signal?.throwIfAborted();
            const subscription = await source.subscribe(
              consumer,
              signal,
            );
            if (!subscription)
              throw new Error(
                "Selected encoded track is unavailable",
              );
            subscriptions.push(subscription);
          }
          let stopping: Promise<void> | undefined;
          return {
            encodedAudio: true,
            pause: () =>
              subscriptions.forEach((source) =>
                source.pause(),
              ),
            resume: () =>
              subscriptions.forEach((source) =>
                source.resume(),
              ),
            stop: () =>
              (stopping ??= Promise.all(
                subscriptions.map((source) =>
                  source.stop(),
                ),
              ).then(() => {})),
          };
        } catch (error) {
          await Promise.allSettled(
            subscriptions.map((source) => source.stop()),
          );
          throw error;
        }
      },
    },
    video,
  ];
}
