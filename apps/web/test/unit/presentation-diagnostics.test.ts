// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { PresentationDiagnostics } from "@/libs/application/automation/presentation";

afterEach(() => vi.restoreAllMocks());

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
