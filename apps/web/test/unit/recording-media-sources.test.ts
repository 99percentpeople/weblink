// @vitest-environment node
import { expect, it, vi } from "vitest";
import { recordingMediaSources } from "@/libs/domain/recording-media-sources";
import type { EncodedMediaSource } from "@/libs/domain/encoded-video";

function tap() {
  const subscription = {
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(async () => {}),
  };
  return {
    subscription,
    subscribe: vi.fn(() => subscription),
  };
}
it("pairs exactly the selected audio, keeps video-only fallback, and drains both once", async () => {
  const video = tap(),
    audio = tap();
  const sources = recordingMediaSources(video, [audio]);
  expect(sources[1]).toBe(video);
  const consumer = {
    frame: vi.fn(),
    encodedAudio: vi.fn(),
    ended: vi.fn(),
  };
  const subscription =
    (await sources[0].subscribe(consumer))!;
  expect(subscription.encodedAudio).toBe(true);
  for (const source of [video, audio])
    expect(source.subscribe).toHaveBeenCalledWith(
      consumer,
      undefined,
    );
  subscription.resume();
  subscription.pause();
  await Promise.all([
    subscription.stop(),
    subscription.stop(),
  ]);
  for (const source of [video, audio]) {
    expect(
      source.subscription.resume,
    ).toHaveBeenCalledOnce();
    expect(
      source.subscription.pause,
    ).toHaveBeenCalledOnce();
    expect(source.subscription.stop).toHaveBeenCalledOnce();
  }
});
it("rolls back the first subscription when the second track cannot be borrowed", async () => {
  const video = tap(),
    audio: EncodedMediaSource = { subscribe: () => null };
  await expect(
    recordingMediaSources(video, [audio])[0].subscribe({
      frame() {},
      ended() {},
    }),
  ).rejects.toThrow();
  expect(video.subscription.stop).toHaveBeenCalledOnce();
});
it("keeps mixing fallback for multiple, absent or unrelated audio sources", () => {
  const video = tap(),
    audio = tap();
  for (const tracks of [[], [undefined], [audio, audio]])
    expect(recordingMediaSources(video, tracks)).toEqual([
      video,
    ]);
  expect(recordingMediaSources(undefined, [audio])).toEqual(
    [],
  );
});
