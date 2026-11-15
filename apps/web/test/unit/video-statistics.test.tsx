// @vitest-environment jsdom
import { createSignal, Show } from "solid-js";
import { render, cleanup } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { createVideoStatistics } from "@/libs/hooks/video-statistics";
import type { VideoStatsBatch } from "@/libs/domain/video-stats";
const nativeSample = vi.hoisted(() => vi.fn());
vi.mock("@/libs/platform/runtime", () => ({
  platform: { videoPresentation: { sample: nativeSample } },
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  nativeSample.mockReset();
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
            processingSeconds: frame * 0.6,
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
  expect(values()[0].history).toHaveLength(2);
  expect(values()[0].history?.at(-1)?.fps).toBe(30);
  expect(
    values()[0].history?.at(-1)?.receiveToDecodeMs,
  ).toBeCloseTo(20);
  expect(values()[0].counters).toMatchObject({
    current: { timestamp: 2000, frames: 60 },
    previous: { timestamp: 1000, frames: 30 },
  });
  setTrack({ readyState: "live" } as MediaStreamTrack);
  await vi.advanceTimersByTimeAsync(0);
  expect(values()[0].fps).toBeUndefined();
  expect(values()[0].counters?.previous).toBeUndefined();
  expect(values()[0].history).toHaveLength(1);
  visibility.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  const calls = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
  visibility.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(values()[0].fps).toBeUndefined();
  expect(values()[0].history).toHaveLength(1);
});

it("retains a presentation history gap when the native sampler temporarily has no data", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  const close = vi.fn();
  nativeSample.mockReturnValue({
    read: vi
      .fn()
      .mockReturnValueOnce({
        fps: 59,
        onePercentLowFps: 40,
      })
      .mockReturnValue({}),
    close,
  });
  const video = document.createElement("video");
  const track = { readyState: "live" } as MediaStreamTrack;
  let tick = 0;
  let values!: ReturnType<typeof createVideoStatistics>;
  const view = render(() => {
    values = createVideoStatistics(
      () => track,
      () => video,
      async () => [
        {
          key: "pc",
          direction: "receive",
          samples: [
            {
              id: "video",
              timestamp: ++tick * 1000,
              frames: tick * 60,
            },
          ],
        },
      ],
    );
    return <span />;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(values()[0].fps).toBe(60);
  const display = values().find(
    (row) => row.direction === "display",
  );
  expect(display?.fps).toBeUndefined();
  expect(
    display?.history?.map((point) => point.fps),
  ).toEqual([59, undefined]);
  expect(
    display?.history?.map(
      (point) => point.onePercentLowFps,
    ),
  ).toEqual([40, undefined]);
  view.unmount();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps histories with their transports when equally named peers reorder or reconnect", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  const video = document.createElement("video");
  const track = { readyState: "live" } as MediaStreamTrack;
  const first = {};
  let second = {};
  let tick = 0;
  let reverse = false;
  let showFirst = true;
  const batch = (
    key: object,
    fps: number,
  ): VideoStatsBatch => ({
    key,
    direction: "receive",
    peer: "Same name",
    samples: [
      {
        id: "video",
        codec: "video/VP8",
        timestamp: tick * 1000,
        frames: tick * fps,
      },
    ],
  });
  const read = vi.fn(async () => {
    tick++;
    const batches = [batch(second, 60)];
    if (showFirst) batches.unshift(batch(first, 30));
    return reverse ? batches.reverse() : batches;
  });
  let rows!: ReturnType<typeof createVideoStatistics>;
  render(() => {
    rows = createVideoStatistics(
      () => track,
      () => video,
      read,
    );
    return <span />;
  });
  await vi.advanceTimersByTimeAsync(1000);
  reverse = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    rows()
      .filter((row) => row.direction === "receive")
      .map((row) => row.history?.map((point) => point.fps)),
  ).toEqual([
    [undefined, 60, 60],
    [undefined, 30, 30],
  ]);
  showFirst = false;
  await vi.advanceTimersByTimeAsync(1000);
  showFirst = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(rows()[1].history).toHaveLength(1);
  second = {};
  await vi.advanceTimersByTimeAsync(1000);
  expect(rows()[0].history).toHaveLength(1);
  expect(rows()[0].fps).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(6);
});
