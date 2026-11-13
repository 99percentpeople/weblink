// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PresentationDiagnostics } from "@/libs/application/automation/presentation";

afterEach(() => vi.restoreAllMocks());

it("does not let a retired cleanup remove a replacement observer", () => {
  const track = {} as MediaStreamTrack;
  const video = document.createElement("video");
  const previous = {
    read: () => ({ id: 1 }),
    close: vi.fn(),
  };
  const current = {
    read: () => ({ id: 2 }),
    close: vi.fn(),
  };
  const native = vi
    .fn()
    .mockReturnValueOnce(previous)
    .mockReturnValue(current);
  const diagnostics = new PresentationDiagnostics(native);
  const stopPrevious = diagnostics.watch(track, video);
  diagnostics.clear();
  const stopCurrent = diagnostics.watch(track, video);

  stopPrevious();
  stopPrevious();
  expect(previous.close).toHaveBeenCalledTimes(1);
  expect(current.close).not.toHaveBeenCalled();
  expect(diagnostics.read(track)).toEqual([
    expect.objectContaining({ id: 2 }),
  ]);

  stopCurrent();
  diagnostics.clear();
  expect(current.close).toHaveBeenCalledTimes(1);
  expect(diagnostics.read(track)).toEqual([]);
});

it("releases each observer independently and makes its cleanup idempotent", () => {
  const track = {} as MediaStreamTrack;
  const video = document.createElement("video");
  const first = { read: () => ({ id: 1 }), close: vi.fn() };
  const second = {
    read: () => ({ id: 2 }),
    close: vi.fn(),
  };
  const native = vi
    .fn()
    .mockReturnValueOnce(first)
    .mockReturnValue(second);
  const diagnostics = new PresentationDiagnostics(native);
  const stopFirst = diagnostics.watch(track, video);
  const stopSecond = diagnostics.watch(track, video);
  stopFirst();
  stopFirst();
  expect(first.close).toHaveBeenCalledTimes(1);
  expect(diagnostics.read(track)).toEqual([
    expect.objectContaining({ id: 2 }),
  ]);
  diagnostics.clear();
  stopSecond();
  expect(second.close).toHaveBeenCalledTimes(1);
});

it("labels background quality counters and restarts the visible sampling baseline", () => {
  const hidden = vi
    .spyOn(document, "hidden", "get")
    .mockReturnValue(false);
  const visibility = vi
    .spyOn(document, "visibilityState", "get")
    .mockReturnValue("visible");
  const video = document.createElement("video");
  const quality = {
    totalVideoFrames: 100,
    droppedVideoFrames: 2,
  };
  video.getVideoPlaybackQuality = () =>
    quality as VideoPlaybackQuality;
  const track = {} as MediaStreamTrack;
  const diagnostics = new PresentationDiagnostics();
  const close = diagnostics.watch(track, video);
  expect(diagnostics.read(track)[0]).toMatchObject({
    documentVisibility: "visible",
    droppedFrames: 2,
  });
  hidden.mockReturnValue(true);
  visibility.mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  quality.totalVideoFrames += 120;
  quality.droppedVideoFrames += 120;
  const background = diagnostics.read(track)[0];
  expect(background).toMatchObject({
    documentVisibility: "hidden",
    totalFrames: 220,
    droppedFrames: 122,
  });
  expect(background.fps).toBeUndefined();
  expect(background.droppedPerSecond).toBeUndefined();
  hidden.mockReturnValue(false);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));
  const resumed = diagnostics.read(track)[0];
  expect(resumed.documentVisibility).toBe("visible");
  expect(resumed.droppedPerSecond).toBeUndefined();
  close();
  expect(diagnostics.read(track)).toEqual([]);
});
