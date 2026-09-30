import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createLiveVideoSettings } from "@/libs/application/live-video-settings";
import { getDefaultAppOptions } from "@/libs/state/app-options";
import type { NativeScreenPublication } from "@/libs/domain/native-screen/session";

const options = () => ({
  ...getDefaultAppOptions(),
  videoResolution: "720p" as const,
  videoFrameRate: 30,
});
const track = () =>
  ({
    readyState: "live",
    getConstraints: () => ({
      deviceId: { exact: "selected-camera" },
      facingMode: "user",
    }),
    applyConstraints: vi.fn(
      async (_constraints: MediaTrackConstraints) => {},
    ),
  }) as unknown as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({ getVideoTracks: () => tracks }) as MediaStream;
const tick = () => vi.advanceTimersByTimeAsync(200);
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("live video settings", () => {
  it("keeps device constraints and capture identity while coalescing resolution and FPS edits", async () => {
    const video = track();
    const current = options();
    const error = vi.fn();
    const controller = createLiveVideoSettings({
      publication: () => undefined,
      error,
    });
    controller.sync(stream(video), current);
    controller.sync(stream(video), {
      ...current,
      videoFrameRate: 60,
    });
    await tick();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    expect(video.applyConstraints).toHaveBeenLastCalledWith(
      {
        deviceId: { exact: "selected-camera" },
        facingMode: "user",
        width: { ideal: 1280, max: 1280 },
        height: { ideal: 720, max: 720 },
        frameRate: { ideal: 60, max: 60 },
      },
    );
    const codecOnly = {
      ...current,
      videoFrameRate: 60,
      preferredVideoCodec: "video/vp9",
      nativeScreenCodec: "video/h264",
    };
    controller.sync(stream(video), codecOnly);
    await tick();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("updates native control instead of the decoded preview and leaves session settings unchanged", async () => {
    const video = track();
    const updateVideoSettings = vi.fn(async () => {});
    const publication = {
      updateVideoSettings,
    } as unknown as NativeScreenPublication;
    const controller = createLiveVideoSettings({
      publication: () => publication,
      error: vi.fn(),
    });
    controller.sync(stream(video), {
      ...options(),
      nativeScreenCodec: "video/vp9",
      nativeScreenEncoder: "software",
      videoMaxBitrate: 2_000_000,
      degradationPreference: "maintain-resolution",
    });
    await tick();
    expect(updateVideoSettings).toHaveBeenCalledWith({
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 30,
      maxBitrate: 2_000_000,
      degradationPreference: "maintain-resolution",
    });
    expect(video.applyConstraints).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("serializes writes and only applies the latest edit after a slow request", async () => {
    const video = track();
    let finish!: () => void;
    vi.mocked(
      video.applyConstraints,
    ).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = createLiveVideoSettings({
      publication: () => undefined,
      error: vi.fn(),
    });
    controller.sync(stream(video), options());
    await tick();
    controller.sync(stream(video), {
      ...options(),
      videoFrameRate: 15,
    });
    await tick();
    controller.sync(stream(video), {
      ...options(),
      videoFrameRate: 60,
    });
    await tick();
    expect(video.applyConstraints).toHaveBeenCalledOnce();
    finish();
    await tick();
    expect(video.applyConstraints).toHaveBeenCalledTimes(2);
    expect(video.applyConstraints).toHaveBeenLastCalledWith(
      expect.objectContaining({
        frameRate: { ideal: 60, max: 60 },
      }),
    );
    controller.dispose();
  });

  it("discards pending updates when a track ends, is removed, or the owner disposes", async () => {
    const removed = track(),
      ended = track(),
      disposed = track();
    const controller = createLiveVideoSettings({
      publication: () => undefined,
      error: vi.fn(),
    });
    controller.sync(stream(removed, ended), options());
    Object.assign(ended, { readyState: "ended" });
    controller.sync(stream(ended), options());
    await tick();
    controller.sync(stream(disposed), options());
    controller.dispose();
    await tick();
    for (const video of [removed, ended, disposed])
      expect(video.applyConstraints).not.toHaveBeenCalled();
  });

  it("reports rejected updates once, leaves capture alive and can apply a later change", async () => {
    const video = track(),
      error = vi.fn();
    vi.mocked(video.applyConstraints).mockRejectedValueOnce(
      new Error("Unsupported dimensions"),
    );
    const controller = createLiveVideoSettings({
      publication: () => undefined,
      error,
    });
    controller.sync(stream(video), options());
    await tick();
    controller.sync(stream(video), options());
    await tick();
    expect(error).toHaveBeenCalledOnce();
    expect(video.readyState).toBe("live");
    controller.sync(stream(video), {
      ...options(),
      videoResolution: "480p",
    });
    await tick();
    expect(video.applyConstraints).toHaveBeenCalledTimes(2);
    controller.dispose();
  });
});
