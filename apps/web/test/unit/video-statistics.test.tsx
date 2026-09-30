// @vitest-environment jsdom
import { createSignal, Show } from "solid-js";
import { render, cleanup } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createVideoStatistics } from "@/libs/hooks/video-statistics";
import type { VideoStatsBatch } from "@/libs/domain/video-stats";
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("serializes polling, discards late results and stops when the overlay is hidden", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  const track = {
    readyState: "live",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const video = document.createElement("video");
  let resolve!: (value: VideoStatsBatch[]) => void;
  const read = vi.fn(
    () =>
      new Promise<VideoStatsBatch[]>((done) => {
        resolve = done;
      }),
  );
  const [shown, show] = createSignal(true);
  const Probe = () => {
    const stats = createVideoStatistics(
      () => track,
      () => video,
      read,
    );
    return <span>{JSON.stringify(stats())}</span>;
  };
  const result = render(() => (
    <Show when={shown()}>
      <Probe />
    </Show>
  ));
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(1);
  resolve([]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(2);
  show(false);
  resolve([]);
  await vi.advanceTimersByTimeAsync(5000);
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.container.textContent).toBe("");
  expect(track.stop).not.toHaveBeenCalled();
});
it("resets baselines on a track change and does not sample hidden documents", async () => {
  vi.useFakeTimers();
  const visibility = vi
    .spyOn(document, "hidden", "get")
    .mockReturnValue(false);
  const [track, setTrack] = createSignal({
    readyState: "live",
  } as MediaStreamTrack);
  const video = document.createElement("video");
  let frame = 0;
  const read = vi.fn(
    async (): Promise<VideoStatsBatch[]> => [
      {
        key: "pc",
        direction: "receive",
        samples: [
          {
            id: "video",
            codec: "video/VP8",
            timestamp: ++frame * 1000,
            frames: frame * 30,
            bytes: frame * 1000,
          },
        ],
      },
    ],
  );
  let values!: ReturnType<typeof createVideoStatistics>;
  render(() => {
    values = createVideoStatistics(
      track,
      () => video,
      read,
    );
    return <span />;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(values()[0].fps).toBe(30);
  setTrack({ readyState: "live" } as MediaStreamTrack);
  await vi.advanceTimersByTimeAsync(0);
  expect(values()[0].fps).toBeUndefined();
  visibility.mockReturnValue(true);
  const calls = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(calls);
  visibility.mockReturnValue(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(values()[0].fps).toBeUndefined();
});
