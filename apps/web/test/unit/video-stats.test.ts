import { expect, it, vi } from "vitest";
import {
  readBrowserVideoStats,
  videoStatsValue,
  type VideoStatsSample,
} from "@/libs/domain/video-stats";
const sample: VideoStatsSample = {
  id: "v",
  timestamp: 1000,
  codec: "video/H264",
  width: 1920,
  height: 1080,
  frames: 30,
  bytes: 100_000,
  encodeFrames: 30,
  encodeSeconds: 0.12,
  decodeSeconds: 0.06,
  jitterSeconds: 0.3,
  jitterFrames: 30,
};
it("uses interval deltas for bitrate, FPS and actual per-frame processing time", () => {
  const value = videoStatsValue(
    {
      ...sample,
      timestamp: 2000,
      frames: 90,
      bytes: 350_000,
      encodeFrames: 80,
      encodeSeconds: 0.37,
      decodeSeconds: 0.18,
      jitterSeconds: 0.9,
      jitterFrames: 90,
    },
    sample,
  );
  expect(value.bitrate).toBe(2_000_000);
  expect(value.fps).toBe(60);
  expect(value.encodeMs).toBe(5); // Native frames timed need not equal RTP frames.
  expect(value.decodeMs).toBe(2);
  expect(value.jitterMs).toBeCloseTo(10);
});
it("does not invent rates before a baseline, after reset or when unavailable", () => {
  expect(videoStatsValue(sample).bitrate).toBeUndefined();
  expect(
    videoStatsValue(sample, sample).fps,
  ).toBeUndefined();
  expect(
    videoStatsValue(
      { ...sample, timestamp: 2000, frames: 1 },
      sample,
    ).encodeMs,
  ).toBeUndefined();
  expect(
    videoStatsValue(
      { ...sample, id: "replacement", timestamp: 2000 },
      sample,
    ).bitrate,
  ).toBeUndefined();
  expect(
    videoStatsValue(
      { ...sample, codec: "video/VP9", timestamp: 2000 },
      sample,
    ).bitrate,
  ).toBeUndefined();
  const idle = videoStatsValue(
    { ...sample, timestamp: 2000 },
    sample,
  );
  expect(idle.fps).toBe(0);
  expect(idle.bitrate).toBe(0);
  expect(idle.encodeMs).toBeUndefined();
  expect(idle.decodeMs).toBeUndefined();
  expect(
    videoStatsValue(
      { ...sample, timestamp: 2000, frames: undefined },
      { ...sample, frames: undefined },
    ).bitrate,
  ).toBe(0);
});
it("separates packet waits, encoded frames and fresh capture frames", () => {
  const before: VideoStatsSample = {
    id: "native",
    timestamp: 1000,
    encodeFrames: 100,
    encoderQueueSeconds: 0.2,
    freshFrames: 40,
    captureToEncodeSeconds: 0.8,
    packetsSent: 1000,
    sendDelaySeconds: 2,
  };
  const after: VideoStatsSample = {
    ...before,
    timestamp: 2000,
    encodeFrames: 150,
    encoderQueueSeconds: 0.3,
    freshFrames: 50,
    captureToEncodeSeconds: 1,
    packetsSent: 1200,
    sendDelaySeconds: 2.6,
    roundTripSeconds: 0.012,
  };
  const value = videoStatsValue(after, before);
  expect(value.encoderQueueMs).toBeCloseTo(2);
  expect(value.captureToEncodeMs).toBeCloseTo(20);
  expect(value.sendDelayMs).toBeCloseTo(3);
  expect(value.roundTripMs).toBe(12);
  // Static repeated frames must not produce an apparent capture-age delay.
  expect(
    videoStatsValue(
      { ...after, timestamp: 3000, encodeFrames: 160 },
      after,
    ).captureToEncodeMs,
  ).toBeUndefined();
  expect(
    videoStatsValue(
      { ...after, timestamp: 3000, packetsSent: 1 },
      after,
    ).sendDelayMs,
  ).toBeUndefined();
  expect(
    videoStatsValue({ id: "no-metrics", timestamp: 1000 })
      .roundTripMs,
  ).toBeUndefined();
});
it("reads packet queue counters and RTT only from the selected track transport", async () => {
  const track = {} as MediaStreamTrack;
  const entries = [
    {
      id: "v",
      type: "outbound-rtp",
      kind: "video",
      timestamp: 1000,
      transportId: "transport",
      packetsSent: 500,
      totalPacketSendDelay: 0.75,
    },
    {
      id: "transport",
      type: "transport",
      selectedCandidatePairId: "selected",
    },
    {
      id: "other",
      type: "candidate-pair",
      currentRoundTripTime: 2,
    },
    {
      id: "selected",
      type: "candidate-pair",
      currentRoundTripTime: 0.008,
    },
  ];
  const pc = {
    getSenders: () => [
      {
        track,
        getStats: async () =>
          new Map(entries.map((e) => [e.id, e])),
      },
    ],
  } as unknown as RTCPeerConnection;
  const [sample] = await readBrowserVideoStats(
    pc,
    track,
    "send",
  );
  expect(sample.packetsSent).toBe(500);
  expect(sample.sendDelaySeconds).toBe(0.75);
  expect(sample.roundTripSeconds).toBe(0.008);
  entries.splice(3, 1);
  expect(
    (await readBrowserVideoStats(pc, track, "send"))[0]
      .roundTripSeconds,
  ).toBeUndefined();
});
it("reads only the selected receiver and excludes audio and repair payloads", async () => {
  const track = {} as MediaStreamTrack;
  const unrelated = vi.fn();
  const getStats = vi.fn(
    async () =>
      new Map([
        [
          "codec",
          {
            id: "codec",
            type: "codec",
            mimeType: "video/VP8",
          },
        ],
        [
          "repair",
          {
            id: "repair",
            type: "codec",
            mimeType: "video/rtx",
          },
        ],
        [
          "video",
          {
            id: "video",
            type: "inbound-rtp",
            kind: "video",
            timestamp: 1000,
            codecId: "codec",
            framesDecoded: 7,
            bytesReceived: 99,
            totalDecodeTime: 0.002,
          },
        ],
        [
          "rtx",
          {
            id: "rtx",
            type: "inbound-rtp",
            kind: "video",
            timestamp: 1000,
            codecId: "repair",
          },
        ],
        [
          "audio",
          {
            id: "audio",
            type: "inbound-rtp",
            kind: "audio",
            timestamp: 1000,
          },
        ],
      ]),
  );
  const pc = {
    getReceivers: () => [
      { track: {}, getStats: unrelated },
      { track, getStats },
    ],
    getSenders: () => [],
  } as unknown as RTCPeerConnection;
  const result = await readBrowserVideoStats(
    pc,
    track,
    "receive",
  );
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    id: "video",
    codec: "video/VP8",
    frames: 7,
    bytes: 99,
    decodeSeconds: 0.002,
  });
  expect(result[0].encodeSeconds).toBeUndefined();
  expect(unrelated).not.toHaveBeenCalled();
  expect(
    await readBrowserVideoStats(pc, track, "send"),
  ).toEqual([]);
});
