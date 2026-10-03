import { describe, expect, it } from "vitest";
import { getDefaultAppOptions } from "@/libs/state/app-options";
import {
  displayVideoFrameRates,
  meetingVideoConstraints,
  nativeScreenOptions,
} from "@/libs/application/meeting-video-settings";

describe("meeting capture settings", () => {
  it("uses the same selected limits for camera, display capture and native capture", () => {
    const options = {
      ...getDefaultAppOptions(),
      videoResolution: "720p" as const,
      videoFrameRate: 60,
      videoMaxBitrate: 4_000_000,
      nativeScreenCodec: "video/h264",
      preferredVideoCodec: "video/vp9",
    };
    expect(meetingVideoConstraints(options)).toEqual({
      width: { ideal: 1280, max: 1280 },
      height: { ideal: 720, max: 720 },
      frameRate: { ideal: 60, max: 60 },
    });
    expect(nativeScreenOptions(options)).toEqual({
      audioSampleRate: 48000,
      audioChannelCount: 2,
      audioCodec: null,
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 60,
      maxBitrate: 4_000_000,
      codec: "video/h264",
      encoder: "auto",
      degradationPreference: "balanced",
    });
  });
  it("bounds corrupted persisted limits before invoking native code", () => {
    const options = {
      ...getDefaultAppOptions(),
      videoResolution: "bogus",
      videoFrameRate: NaN,
      videoMaxBitrate: Infinity,
      degradationPreference: "bogus",
    } as any;
    expect(nativeScreenOptions(options)).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
      frameRate: 30,
      maxBitrate: 25 * 1024 * 1024,
      degradationPreference: "balanced",
    });
    options.videoResolution = "__proto__";
    expect(nativeScreenOptions(options).maxWidth).toBe(
      1920,
    );
    options.videoFrameRate = 10_000;
    options.videoMaxBitrate = -1;
    expect(nativeScreenOptions(options)).toMatchObject({
      frameRate: 1000,
      maxBitrate: 128 * 1024,
    });
  });
  it("does not reset existing bitrate or browser codec preferences", () => {
    const options = {
      ...getDefaultAppOptions(),
      videoMaxBitrate: 9_000_000,
      preferredVideoCodec: "video/vp9",
      preferredAudioCodec: "audio/opus",
    };
    expect(nativeScreenOptions(options).maxBitrate).toBe(
      9_000_000,
    );
    expect(nativeScreenOptions(options).codec).toBeNull();
    expect(options.preferredVideoCodec).toBe("video/vp9");
    expect(options.preferredAudioCodec).toBe("audio/opus");
  });
});

it("derives sorted frame-rate options from valid active displays", () => {
  expect(
    displayVideoFrameRates([
      60,
      144,
      144,
      0,
      1,
      NaN,
      Infinity,
      2000,
    ]),
  ).toEqual([15, 24, 30, 60, 90, 120, 144]);
  expect(displayVideoFrameRates([50])).toEqual([
    15, 24, 30, 50,
  ]);
  expect(displayVideoFrameRates([60, 154])).toEqual([
    15, 24, 30, 60, 90, 120, 144, 154,
  ]);
  expect(displayVideoFrameRates([])).toEqual([
    15, 24, 30, 60,
  ]);
  expect(displayVideoFrameRates([0, 1, NaN])).toEqual([
    15, 24, 30, 60,
  ]);
});

it("passes high-refresh native settings through without the former 60 FPS cap", () => {
  expect(
    nativeScreenOptions({
      ...getDefaultAppOptions(),
      videoFrameRate: 144,
    }).frameRate,
  ).toBe(144);
});
