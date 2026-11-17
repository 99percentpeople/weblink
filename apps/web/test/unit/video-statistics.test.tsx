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
it("clears incompatible sender latency history while retaining frame rate history", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  const track = { readyState: "live" } as MediaStreamTrack;
  const video = document.createElement("video");
  let tick = 0;
  const read = async (): Promise<VideoStatsBatch[]> => [
    {
      key: "pc",
      direction: "send",
      samples: [
        {
          id: "video",
          codec: "video/VP8",
          timestamp: ++tick * 1000,
          frames: tick * 60,
          encodeFrames: tick * 60,
          encodeSeconds: tick * 0.12,
          packetsSent: tick * 100,
          sendDelaySeconds: tick * 0.1,
          ...(tick >= 3
            ? {
                sendFrame: {
                  ssrc: 7,
                  rtpTimestamp: tick,
                  ageMs: 0,
                  captureToPacketizerMs: 10,
                  endpoint: "packetizer-input" as const,
                },
              }
            : {}),
        },
      ],
    },
  ];
  let rows!: ReturnType<typeof createVideoStatistics>;
  render(() => {
    rows = createVideoStatistics(
      () => track,
      () => video,
      read,
      () => true,
    );
    return <span />;
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(rows()[0].sendLatencyMs).toBeCloseTo(3);
  await vi.advanceTimersByTimeAsync(1000);
  expect(
    rows()[0].history?.map((point) => point.sendLatencyMs),
  ).toEqual([undefined, undefined, 10]);
  expect(
    rows()[0].history?.map((point) => point.fps),
  ).toEqual([undefined, 60, 60]);
  expect(
    rows()
      .find((row) => row.direction === "display")
      ?.senderOverviewHistory?.map(
        (point) => point.sendLatencyMs,
      ),
  ).toEqual([undefined, undefined, 10]);
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
        submitMs: 0.2,
        presentationQueueMs: 1.5,
        endToEndMs: 80,
        endToEndState: "estimated",
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
  expect(display?.endToEndMs).toBeUndefined();
  expect(
    display?.history?.map((point) => point.endToEndMs),
  ).toEqual([80, undefined]);
  expect(
    display?.history?.map((point) => point.fps),
  ).toEqual([59, undefined]);
  expect(
    display?.history?.map(
      (point) => point.onePercentLowFps,
    ),
  ).toEqual([40, undefined]);
  expect(
    display?.history?.map((point) => point.submitMs),
  ).toEqual([0.2, undefined]);
  expect(
    display?.history?.map(
      (point) => point.presentationQueueMs,
    ),
  ).toEqual([1.5, undefined]);
  view.unmount();
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["send", "receive"] as const)(
  "keeps %s histories with their transports when equally named peers reorder or reconnect",
  async (direction) => {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(
      false,
    );
    const video = document.createElement("video");
    const track = {
      readyState: "live",
    } as MediaStreamTrack;
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
      direction,
      peer: "Same name",
      samples: [
        {
          id: "video",
          codec: "video/VP8",
          timestamp: tick * 1000,
          frames: tick * fps,
          ...(direction === "send"
            ? {
                encodeFrames: tick * fps,
                encodeSeconds: tick * fps * 0.002,
                packetsSent: tick * 100,
                sendDelaySeconds: tick * 0.1,
                bytes: tick * fps * 1000,
              }
            : {}),
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
        () => direction === "send",
      );
      return <span />;
    });
    await vi.advanceTimersByTimeAsync(1000);
    reverse = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      rows()
        .filter((row) => row.direction === direction)
        .map((row) =>
          row.history?.map((point) => point.fps),
        ),
    ).toEqual([
      [undefined, 60, 60],
      [undefined, 30, 30],
    ]);
    if (direction === "send") {
      for (const row of rows().filter(
        (row) => row.direction === "send",
      )) {
        expect(row.sendLatencyBasis).toBe("encode");
        expect(row.sendLatencyMs).toBeCloseTo(3);
        expect(
          row.history?.map((point) => point.sendLatencyMs),
        ).toEqual([
          undefined,
          expect.closeTo(3),
          expect.closeTo(3),
        ]);
      }
    }
    showFirst = false;
    await vi.advanceTimersByTimeAsync(1000);
    showFirst = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(rows()[1].history).toHaveLength(1);
    second = {};
    await vi.advanceTimersByTimeAsync(1000);
    expect(rows()[0].history).toHaveLength(1);
    expect(rows()[0].fps).toBeUndefined();
    expect(rows()[0].sendLatencyMs).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(6);
    const display = rows().find(
      (row) => row.direction === "display",
    );
    if (direction === "send") {
      expect(
        display?.senderOverviewHistory?.map(
          (point) => point.bitrate,
        ),
      ).toEqual([
        undefined,
        720_000,
        720_000,
        480_000,
        undefined,
        undefined,
      ]);
      expect(
        display?.senderOverviewHistory?.map(
          (point) => point.sendLatencyMs,
        ),
      ).toEqual([
        undefined,
        expect.closeTo(3),
        expect.closeTo(3),
        expect.closeTo(3),
        expect.closeTo(3),
        expect.closeTo(3),
      ]);
      // Sender aggregates must not turn into duplicate local-preview metrics.
      expect(
        display?.history?.every(
          (point) =>
            point.bitrate === undefined &&
            point.sendLatencyMs === undefined,
        ),
      ).toBe(true);
    } else
      expect(
        display?.senderOverviewHistory,
      ).toBeUndefined();
  },
);
