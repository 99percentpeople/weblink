import { expect, it } from "vitest";
import {
  browserSendFrameStats,
  readSendFrameStats,
} from "@/libs/domain/video-send-frame-stats";
import { videoStatsValue } from "@/libs/domain/video-stats";

const frame = {
  ssrc: 7,
  rtpTimestamp: 0xfffffffe,
  ageMs: 10,
  captureToPacketizerMs: 12,
  packetizerToSendMs: 18,
  captureToSendMs: 30,
  endpoint: "transport-submit" as const,
};
it("uses one frame from the first sample without adding interval means or RTT", () => {
  const sample = {
    id: "v",
    timestamp: 1000,
    sendFrame: frame,
    roundTripSeconds: 0.9,
  };
  expect(videoStatsValue(sample)).toMatchObject({
    sendLatencyMs: 30,
    captureToPacketizerMs: 12,
    packetizerToSendMs: 18,
    sendLatencyBasis: "frame",
    sendLatencyEndpoint: "transport-submit",
    sendLatencyState: "measured",
  });
  expect(
    videoStatsValue(
      {
        ...sample,
        timestamp: 2000,
        encodeFrames: 2,
        encodeSeconds: 1,
        packetsSent: 2,
        sendDelaySeconds: 2,
      },
      {
        ...sample,
        encodeFrames: 1,
        encodeSeconds: 0,
        packetsSent: 1,
        sendDelaySeconds: 0,
      },
    ).sendLatencyMs,
  ).toBe(30);
});
it("keeps unavailable or stale frame measurements missing instead of falling back to mixed means", () => {
  for (const sendFrame of [
    null,
    { ...frame, ageMs: 1501 },
    { ...frame, captureToSendMs: 45 },
  ]) {
    const before = {
      id: "v",
      timestamp: 1000,
      encodeFrames: 1,
      encodeSeconds: 0,
      packetsSent: 1,
      sendDelaySeconds: 0,
    };
    expect(
      videoStatsValue(
        {
          ...before,
          timestamp: 2000,
          encodeFrames: 2,
          encodeSeconds: 1,
          packetsSent: 2,
          sendDelaySeconds: 1,
          sendFrame,
        },
        before,
      ).sendLatencyMs,
    ).toBeUndefined();
  }
});
it("uses browser capture metadata on its own clock and never treats RTP timestamps as time", () => {
  for (const rtpTimestamp of [0, 1, 0xffffffff]) {
    const timing = browserSendFrameStats(
      { synchronizationSource: 7, captureTime: 100 },
      rtpTimestamp,
      112,
    );
    expect(timing).toEqual({
      ssrc: 7,
      rtpTimestamp,
      ageMs: 0,
      captureToPacketizerMs: 12,
      endpoint: "packetizer-input",
    });
    expect(
      videoStatsValue({
        id: "v",
        timestamp: 1000,
        sendFrame: timing,
      }),
    ).toMatchObject({
      sendLatencyMs: 12,
      sendLatencyEndpoint: "packetizer-input",
      sendLatencyState: "partial",
    });
  }
  for (const captureTime of [
    undefined,
    NaN,
    Infinity,
    -1,
    113,
  ])
    expect(
      browserSendFrameStats(
        { synchronizationSource: 7, captureTime },
        90000,
        112,
      ),
    ).toBeUndefined();
  expect(
    readSendFrameStats({
      ...frame,
      captureToPacketizerMs: 0,
      packetizerToSendMs: 0,
      captureToSendMs: 0,
    }),
  ).toBeDefined();
});
