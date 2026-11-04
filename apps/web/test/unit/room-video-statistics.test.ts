import { expect, it, vi } from "vitest";
import type { RoomConnection } from "@weblink/platform";
import type { NativeScreenSession } from "@/libs/domain/native-screen/session";
import { readVideoStatistics } from "@/libs/application/video-statistics-service";

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
