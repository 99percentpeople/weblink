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
  });
  expect(stats.read(4000)).toEqual({
    fps: 0,
    droppedPerSecond: 0,
    receiveToPresentMs: undefined,
  });
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
  });
  Object.assign(video, {
    getVideoPlaybackQuality: undefined,
  });
  expect(stats.read(3000).fps).toBeUndefined();
  stats.close();
});
