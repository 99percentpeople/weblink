// @vitest-environment node
import { expect, it } from "vitest";
import {
  avcUnits,
  encodedRecordingFormat,
  RecordingRtpTimeline,
} from "@/libs/application/recording-encoded-format";
import type { EncodedVideoPacket } from "@/libs/domain/encoded-video";
const packet = (
  overrides: Partial<EncodedVideoPacket> = {},
): EncodedVideoPacket => ({
  data: new Uint8Array([1, 2, 3]).buffer,
  mimeType: "video/VP8",
  type: "key",
  timestamp: 123456,
  width: 640,
  height: 360,
  ssrc: 9,
  spatialIndex: 0,
  segment: 1,
  ...overrides,
});
it("retains VP8 bytes and rejects codec, stream or spatial-layer changes", async () => {
  const first = packet();
  const format = await encodedRecordingFormat(first);
  expect(format.codec).toBe("vp8");
  expect(format.bytes(first)).toEqual(
    new Uint8Array(first.data),
  );
  expect(
    format.compatible(
      packet({ type: "delta", timestamp: 126456 }),
    ),
  ).toBe(true);
  for (const change of [
    { mimeType: "video/H264" },
    { ssrc: 10 },
    { spatialIndex: 1 },
    { width: 320 },
  ])
    expect(format.compatible(packet(change))).toBe(false);
});
it("describes H.264 and delegates Annex B conversion to the common muxer", async () => {
  const data = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x1f, 0x80, 0, 0, 1, 0x68,
    0xaa, 0, 0, 0, 1, 0x65, 0xbb,
  ]);
  const first = packet({
    mimeType: "video/H264",
    data: data.buffer,
  });
  const format = await encodedRecordingFormat(first);
  expect(format.config.codec).toBe("avc1.42e01f");
  expect(format.config.description).toBeUndefined();
  expect(format.type).toBe("video/mp4");
  expect(format.bytes(first)).toEqual(data);
  const changed = data.slice();
  changed[8] = 0x81;
  expect(
    format.compatible({ ...first, data: changed.buffer }),
  ).toBe(false);
});
it("refuses unrecognized encodings and malformed keyframes for fallback", async () => {
  await expect(
    encodedRecordingFormat(
      packet({ mimeType: "video/H266" }),
    ),
  ).rejects.toThrow();
  await expect(
    encodedRecordingFormat(packet({ type: "delta" })),
  ).rejects.toThrow();
  await expect(
    encodedRecordingFormat(
      packet({ mimeType: "video/H264" }),
    ),
  ).rejects.toThrow();
  expect(() =>
    avcUnits(new Uint8Array([4, 3, 2, 1])),
  ).toThrow();
});
it("unwraps RTP timestamps and excludes paused time while resuming on a keyframe", () => {
  const timeline = new RecordingRtpTimeline();
  expect(
    timeline.next(packet({ timestamp: 0xfffffff0 })),
  ).toBe(0);
  expect(
    timeline.next(
      packet({
        timestamp: (0xfffffff0 + 3000) >>> 0,
        type: "delta",
      }),
    ),
  ).toBeCloseTo(1 / 30);
  expect(
    timeline.next(
      packet({ timestamp: 900000, segment: 2 }),
      0.08,
    ),
  ).toBe(0.08);
  expect(
    timeline.next(
      packet({
        timestamp: 903000,
        segment: 2,
        type: "delta",
      }),
    ),
  ).toBeCloseTo(0.08 + 1 / 30);
  expect(() =>
    timeline.next(packet({ segment: 3, type: "delta" })),
  ).toThrow("keyframe");
});
it("allows unchanged-screen gaps longer than a minute without mistaking them for a clock reset", () => {
  const timeline = new RecordingRtpTimeline();
  expect(timeline.next(packet({ timestamp: 0 }))).toBe(0);
  expect(
    timeline.next(
      packet({ timestamp: 90000 * 120, type: "delta" }),
    ),
  ).toBe(120);
  expect(() =>
    new RecordingRtpTimeline().next(
      packet({ type: "delta" }),
    ),
  ).toThrow("keyframe");
});

it("maps native audio and video onto one clock across pauses", () => {
  const timeline = new RecordingRtpTimeline();
  const next = (timestamp: number, segment = 1) =>
    timeline.next(
      packet({
        timestamp,
        timestampScale: 1000000,
        segment,
      }),
    );
  expect(next(5_000_000)).toBe(0);
  expect(next(5_040_000)).toBeCloseTo(0.04);
  expect(timeline.audio(5_010_000, 1)).toBeCloseTo(0.01);
  expect(timeline.audio(5_010_000, 2)).toBeUndefined();
  expect(next(30_000_000, 2)).toBeCloseTo(0.08);
  expect(timeline.audio(30_010_000, 2)).toBeCloseTo(0.09);
});
