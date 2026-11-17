import { expect, it, vi } from "vitest";
import type { RoomConnection } from "@weblink/platform";
import type { NativeScreenSession } from "@/libs/domain/native-screen/session";
import { readVideoStatistics } from "@/libs/application/video-statistics-service";

it("keeps sender frame timing scoped to its peer and SSRC", async () => {
  const track = {
    readyState: "live",
    kind: "video",
  } as MediaStreamTrack;
  const peer = (ssrc: number, delay: number) => ({
    pc: {
      connectionState: "connected",
      getReceivers: () => [],
      getSenders: () => [
        {
          track,
          getStats: async () =>
            new Map([
              [
                "rtp",
                {
                  id: "rtp",
                  type: "outbound-rtp",
                  kind: "video",
                  ssrc,
                  timestamp: 123,
                },
              ],
            ]),
        },
      ],
    } as unknown as RoomConnection,
    sendFrameStats: () => ({
      ssrc,
      rtpTimestamp: 99,
      ageMs: 0,
      captureToPacketizerMs: delay,
      endpoint: "packetizer-input" as const,
    }),
  });
  const first = peer(7, 10),
    second = peer(8, 30);
  expect(
    (await readVideoStatistics(track, [first, second])).map(
      (batch) =>
        batch.samples[0].sendFrame?.captureToPacketizerMs,
    ),
  ).toEqual([10, 30]);
  const mismatch = {
    ...first,
    sendFrameStats: second.sendFrameStats,
  };
  expect(
    (await readVideoStatistics(track, [mismatch]))[0]
      .samples[0].sendFrame,
  ).toBeUndefined();
});

it("samples a shared screen receiver once and keeps dedicated receivers observable", async () => {
  const track = {
    readyState: "live",
    kind: "video",
  } as MediaStreamTrack;
  const getStats = vi.fn(
    async () =>
      new Map([
        [
          "rtp",
          {
            id: "rtp",
            type: "inbound-rtp",
            kind: "video",
            framesDecoded: 10,
            timestamp: 123,
          },
        ],
      ]),
  );
  const pc = {
    getReceivers: () => [{ track, getStats }],
    getSenders: () => [],
    connectionState: "connected",
  } as unknown as RoomConnection;
  const getVideoStats = vi.fn(async () => [
    { key: {}, direction: "receive", samples: [] },
  ]);
  const native = {
    getVideoStats,
  } as unknown as NativeScreenSession;
  expect(
    await readVideoStatistics(track, [{ pc, native }]),
  ).toHaveLength(1);
  expect(getStats).toHaveBeenCalledOnce();
  expect(getVideoStats).not.toHaveBeenCalled();
  expect(
    await readVideoStatistics(track, [
      { pc: null, native },
    ]),
  ).toHaveLength(1);
  expect(getVideoStats).toHaveBeenCalledOnce();
});
