import { expect, it } from "vitest";
import {
  recordingContainerForCodec,
  recordingFormat,
  recordingVideoBitrate,
} from "@/libs/application/recording-options";

it.each([
  ["video/webm;codecs=vp8,opus", "webm"],
  ["video/x-matroska;codecs=avc1,opus", "mkv"],
  ["video/matroska;codecs=h264", "mkv"],
  ["video/mp4;codecs=avc1.42E01E,mp4a.40.2", "mp4"],
])(
  "preserves the actual recorder format %s",
  (type, extension) => {
    expect(recordingFormat(type)).toEqual({
      type,
      extension,
    });
  },
);

it("rejects an unknown format instead of mislabelling its container", () => {
  expect(() => recordingFormat("")).toThrow(
    "Unsupported recording format",
  );
  expect(() => recordingFormat("video/unknown")).toThrow(
    "Unsupported recording format",
  );
});

it("gives higher resolution and frame rate sources more room for screen detail", () => {
  const hd = recordingVideoBitrate({
    width: 1280,
    height: 720,
    frameRate: 30,
  });
  const fullHd = recordingVideoBitrate({
    width: 1920,
    height: 1080,
    frameRate: 30,
  });
  const fast = recordingVideoBitrate({
    width: 1920,
    height: 1080,
    frameRate: 60,
  });
  expect(hd).toBeGreaterThan(2_500_000);
  expect(fullHd).toBeGreaterThan(hd);
  expect(fullHd).toBe(10_000_000);
  expect(fast).toBeGreaterThan(fullHd);
  expect(
    recordingVideoBitrate({
      width: 3840,
      height: 2160,
      frameRate: 60,
    }),
  ).toBe(40_000_000);
});

it("bounds small, large and temporarily incomplete track settings", () => {
  expect(
    recordingVideoBitrate({
      width: 320,
      height: 240,
      frameRate: 15,
    }),
  ).toBe(2_500_000);
  expect(recordingVideoBitrate()).toBe(10_000_000);
  expect(
    recordingVideoBitrate({
      width: NaN,
      height: 0,
      frameRate: Infinity,
    }),
  ).toBe(10_000_000);
  expect(
    recordingVideoBitrate({
      width: 7680,
      height: 4320,
      frameRate: 240,
    }),
  ).toBe(40_000_000);
});

it.each(["g722", "ulaw", "alaw"])(
  "auto selects MKV to preserve %s and respects explicit MP4",
  (audio) => {
    for (const video of [
      "avc",
      "hevc",
      "vp8",
      "vp9",
      "av1",
    ]) {
      expect(
        recordingContainerForCodec("auto", video, audio),
      ).toBe("mkv");
      expect(
        recordingContainerForCodec("mp4", video, audio),
      ).toBe("mp4");
    }
    expect(
      recordingContainerForCodec("auto", "avc", "opus"),
    ).toBe("mp4");
  },
);
