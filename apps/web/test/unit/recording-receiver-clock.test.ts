// @vitest-environment node
import { expect, it } from "vitest";
import { RecordingReceiverClock } from "@/libs/domain/recording-receiver-clock";

it("aligns independent video/audio RTP origins to delivery time and handles RTP wrap", () => {
  const now = performance.now();
  const clock = (rtpTimestamp: number, timestamp: number) =>
    new RecordingReceiverClock({
      getSynchronizationSources: () => [
        { source: 1, rtpTimestamp, timestamp },
      ],
    } as RTCRtpReceiver);
  const video = clock(0xffffff00, now),
    audio = clock(500000, now + 20);
  expect(
    video.time(
      {
        timestamp: (0xffffff00 + 9000) >>> 0,
        ssrc: 1,
        segment: 1,
      },
      90000,
    ),
  ).toBeCloseTo(now + 100);
  expect(
    audio.time(
      { timestamp: 503840, ssrc: 1, segment: 1 },
      48000,
    ),
  ).toBeCloseTo(now + 100);
});

it("normalizes Chromium epoch timestamps without accepting stale delivery anchors", () => {
  const now = performance.now();
  const source = {
    source: 1,
    rtpTimestamp: 3000,
    timestamp: performance.timeOrigin + now,
  };
  const clock = new RecordingReceiverClock({
    getSynchronizationSources: () => [source],
  } as RTCRtpReceiver);
  expect(
    clock.time(
      { timestamp: 6000, segment: 1, ssrc: 1 },
      90000,
    ),
  ).toBeCloseTo(now + 1000 / 30, 2);
  clock.reset();
  source.timestamp -= 5000;
  expect(
    clock.time(
      { timestamp: 6000, segment: 1, ssrc: 1 },
      90000,
    ),
  ).toBeUndefined();
});

it("keeps a continuous clock across many hours and multiple RTP wraps", () => {
  const now = performance.now();
  const clock = new RecordingReceiverClock({
    getSynchronizationSources: () => [
      { source: 1, rtpTimestamp: 0, timestamp: now },
    ],
  } as RTCRtpReceiver);
  for (let hours = 0; hours <= 30; hours += 2)
    expect(
      clock.time(
        {
          timestamp: (hours * 3600 * 90000) >>> 0,
          ssrc: 1,
          segment: 1,
        },
        90000,
      ),
    ).toBeCloseTo(now + hours * 3600 * 1000, 2);
});
it("pins each segment's mapping, refreshes after pause, and rejects stale or unrelated sources", () => {
  const now = performance.now();
  const anchor = {
    source: 1,
    rtpTimestamp: 0,
    timestamp: now,
  };
  const clock = new RecordingReceiverClock({
    getSynchronizationSources: () => [{ ...anchor }],
  } as RTCRtpReceiver);
  const packet = { timestamp: 0, ssrc: 1, segment: 1 };
  expect(clock.time(packet, 90000)).toBe(now);
  anchor.timestamp += 100;
  expect(clock.time(packet, 90000)).toBe(now);
  expect(clock.time({ ...packet, segment: 2 }, 90000)).toBe(
    now + 100,
  );
  expect(
    clock.time({ ...packet, ssrc: 9 }, 90000),
  ).toBeUndefined();
  clock.reset();
  anchor.timestamp -= 10000;
  expect(clock.time(packet, 90000)).toBeUndefined();
});
