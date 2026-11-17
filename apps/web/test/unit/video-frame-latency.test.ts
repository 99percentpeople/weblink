import { expect, it } from "vitest";
import { videoFrameLatency } from "@/libs/domain/video-frame-latency";

it("partitions a frame without double-counting display wait, buffering or decoder work", () => {
  for (const capture of [0, 1, 1_000_000]) {
    for (const beforeReceive of [0, 10, 150]) {
      for (const afterReceive of [0, 3, 50]) {
        const v = videoFrameLatency({
          captureTime: capture,
          receiveTime: capture + beforeReceive,
          presentationTime:
            capture + beforeReceive + afterReceive,
          expectedDisplayTime:
            capture + beforeReceive + afterReceive + 16,
          processingDuration: 0.002,
        });
        expect(
          v.captureToReceiveMs! + v.receiveToPresentMs!,
        ).toBe(v.endToEndMs);
        expect(v.endToEndMs).toBe(
          beforeReceive + afterReceive,
        );
        expect(v.displayWaitMs).toBe(16);
        expect(v.frameDecodeMs).toBe(2);
        expect(v.latencyEndpoint).toBe("compositor-submit");
      }
    }
  }
});

it("never substitutes expected display or callback time for missing submission", () => {
  for (const presentationTime of [
    undefined,
    NaN,
    Infinity,
    -1,
  ]) {
    expect(
      videoFrameLatency({
        captureTime: 1,
        receiveTime: 2,
        presentationTime,
        expectedDisplayTime: 10,
      }),
    ).toEqual({});
  }
});

it("keeps missing, invalid and unsynchronized segments absent rather than clamping them", () => {
  for (const captureTime of [
    undefined,
    NaN,
    Infinity,
    -1,
    11,
  ]) {
    const v = videoFrameLatency({
      captureTime,
      receiveTime: 10,
      presentationTime: 20,
    });
    expect(v.endToEndMs).toBeUndefined();
    expect(v.captureToReceiveMs).toBeUndefined();
    expect(v.receiveToPresentMs).toBe(10);
  }
  const v = videoFrameLatency({
    captureTime: 1,
    receiveTime: 21,
    presentationTime: 20,
    expectedDisplayTime: 19,
    processingDuration: -1,
  });
  expect(v).toEqual({
    latencyEndpoint: "compositor-submit",
  });
  expect(
    videoFrameLatency({
      captureTime: 1,
      presentationTime: 20,
    }).endToEndMs,
  ).toBeUndefined();
});
