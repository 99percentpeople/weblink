// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createVideoPresentationStats } from "@/libs/domain/video-presentation-stats";

afterEach(() => vi.restoreAllMocks());
function setup() {
  const hidden = vi
    .spyOn(document, "hidden", "get")
    .mockReturnValue(false);
  const video = document.createElement("video");
  let pending: VideoFrameRequestCallback | undefined;
  const request = vi.fn(
    (next: VideoFrameRequestCallback) => {
      pending = next;
      return 1;
    },
  );
  const cancel = vi.fn(() => {
    pending = undefined;
  });
  Object.assign(video, {
    requestVideoFrameCallback: request,
    cancelVideoFrameCallback: cancel,
  });
  const quality = {
    totalVideoFrames: 100,
    droppedVideoFrames: 0,
  };
  video.getVideoPlaybackQuality = () =>
    quality as VideoPlaybackQuality;
  const stats = createVideoPresentationStats(video);
  const frame = (
    count: number,
    time: number,
    receiveTime?: number,
  ) => {
    const call = pending!;
    pending = undefined;
    call(time, {
      presentedFrames: count,
      expectedDisplayTime: time + 5,
      receiveTime,
    } as VideoFrameCallbackMetadata);
  };
  return {
    stats,
    video,
    frame,
    quality,
    hidden,
    request,
    cancel,
  };
}

it("measures compositor frame counters independently of callback count or 100 FPS decode", () => {
  const { stats, frame, quality } = setup();
  frame(20, 1000, 980);
  expect(stats.read(1000).fps).toBeUndefined();
  quality.totalVideoFrames += 100;
  quality.droppedVideoFrames += 40;
  // The main thread missed callbacks, but cumulative presentation counters did not.
  frame(80, 2000, 1980);
  expect(stats.read(2000)).toEqual({
    fps: 60,
    droppedPerSecond: 40,
    receiveToPresentMs: 25,
    onePercentLowFps: expect.closeTo(60),
    onePercentLowState: "estimated",
  });
  expect(stats.read(4000)).toEqual({
    fps: 0,
    onePercentLowFps: expect.closeTo(60),
    onePercentLowState: "estimated",
    droppedPerSecond: 0,
    receiveToPresentMs: undefined,
  });
  stats.close();
});

it("reports the mean of the slowest 1% of presentation intervals in a moving window", () => {
  const { stats, frame } = setup();
  let time = 100;
  frame(0, time);
  for (let i = 1; i <= 200; i++) {
    time += i === 5 ? 40 : i === 9 ? 20 : 10;
    frame(i, time);
    if (i === 99)
      expect(stats.read(time).onePercentLowFps).toBe(25);
  }
  expect(stats.read(time).onePercentLowFps).toBeCloseTo(
    1000 / 30,
  );
  // The outliers stay in the ten-second window after another 300 frames.
  for (let i = 201; i <= 500; i++) frame(i, (time += 10));
  expect(stats.read(time).onePercentLowFps).toBeCloseTo(
    1000 / 18,
  );
  for (let i = 501; i <= 1100; i++) frame(i, (time += 10));
  expect(stats.read(time).onePercentLowFps).toBe(100);
  expect(stats.read(time + 10_010).onePercentLowFps).toBe(
    0,
  );
  stats.close();
});

it("labels coalesced callbacks as estimates and resets after hidden time or source changes", () => {
  const { stats, frame, hidden } = setup();
  for (let i = 0; i <= 120; i++) frame(i, i * 10);
  frame(150, 1500);
  expect(stats.read(1500)).toMatchObject({
    onePercentLowFps: 100,
    onePercentLowState: "estimated",
  });
  for (let i = 151; i <= 1151; i++) frame(i, i * 10);
  expect(stats.read(11510).onePercentLowFps).toBe(100);
  expect(
    stats.read(11510).onePercentLowState,
  ).toBeUndefined();
  frame(1, 11520);
  expect(stats.read(11520).onePercentLowFps).toBe(0);
  for (let i = 2; i <= 101; i++) frame(i, 11510 + i * 10);
  expect(stats.read(12520).onePercentLowFps).toBe(100);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  frame(102, 20000);
  expect(stats.read(20000).onePercentLowFps).toBe(0);
  stats.close();
});

it.each([30, 60, 120])(
  "expires a stutter after the same wall time at %i FPS",
  (fps) => {
    const { stats, frame } = setup();
    const interval = 1000 / fps;
    frame(0, 0);
    frame(1, 100);
    for (let n = 1; n <= fps * 10; n++)
      frame(n + 1, 100 + n * interval);
    // expectedDisplayTime is 5 ms after callback time in this fixture.
    expect(stats.read(10104).onePercentLowFps).toBeLessThan(
      fps,
    );
    expect(stats.read(10105).onePercentLowFps).toBeCloseTo(
      fps,
    );
    stats.close();
  },
);

it("weights only the coalesced frames within the cutoff and expires them without callbacks", () => {
  const { stats, frame } = setup();
  frame(0, 0);
  frame(200, 4000); // 200 estimated 20 ms intervals
  for (let i = 1; i <= 990; i++)
    frame(200 + i, 4000 + i * 10);
  // Five of the tail's ten frames still come from the coalesced span.
  expect(stats.read(13905).onePercentLowFps).toBeCloseTo(
    1000 / 15,
  );
  for (let i = 991; i <= 1000; i++)
    frame(200 + i, 4000 + i * 10);
  expect(stats.read(14005)).toMatchObject({
    onePercentLowFps: 100,
  });
  expect(
    stats.read(14005).onePercentLowState,
  ).toBeUndefined();
  expect(stats.read(24005).onePercentLowFps).toBe(0);
  stats.close();
});

it("always returns a number for a visible supported player, starting with its first completed interval", () => {
  const { stats, frame } = setup();
  expect(stats.read(0).onePercentLowFps).toBe(0);
  frame(0, 0);
  expect(stats.read(5).onePercentLowFps).toBe(0);
  frame(1, 200);
  expect(stats.read(205).onePercentLowFps).toBe(5);
  for (let i = 2; i <= 50; i++) frame(i, i * 200);
  expect(stats.read(10005).onePercentLowFps).toBe(5);
  stats.close();
});

it("resets visibility and source counter changes without counting hidden time as a stall", () => {
  const { stats, frame, hidden, cancel } = setup();
  frame(20, 1000);
  stats.read(1000);
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledOnce();
  expect(stats.read(5000)).toEqual({});
  hidden.mockReturnValue(false);
  document.dispatchEvent(new Event("visibilitychange"));
  frame(500, 6000);
  expect(stats.read(6000).fps).toBeUndefined();
  frame(550, 7000);
  expect(stats.read(7000).fps).toBe(50);
  frame(1, 8000);
  expect(stats.read(8000).fps).toBeUndefined();
  stats.close();
});

it("stops callbacks on disposal and rejects missing or invalid latency metadata", () => {
  const { stats, frame, request, cancel } = setup();
  frame(10, 1000, 1100);
  expect(
    stats.read(1000).receiveToPresentMs,
  ).toBeUndefined();
  frame(20, 1100);
  expect(
    stats.read(1100).receiveToPresentMs,
  ).toBeUndefined();
  const requested = request.mock.calls.length;
  stats.close();
  stats.close();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(cancel).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(requested);
  expect(stats.read(2000)).toEqual({});
});

it("subtracts dropped frames in the older-browser fallback and omits unavailable information", () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  const video = document.createElement("video");
  const quality = {
    totalVideoFrames: 100,
    droppedVideoFrames: 30,
  };
  video.getVideoPlaybackQuality = () =>
    quality as VideoPlaybackQuality;
  const stats = createVideoPresentationStats(video);
  stats.read(1000);
  quality.totalVideoFrames += 100;
  quality.droppedVideoFrames += 40;
  expect(stats.read(2000)).toEqual({
    fps: 60,
    droppedPerSecond: 40,
    receiveToPresentMs: undefined,
    onePercentLowState: "unsupported",
  });
  Object.assign(video, {
    getVideoPlaybackQuality: undefined,
  });
  expect(stats.read(3000).fps).toBeUndefined();
  stats.close();
});
