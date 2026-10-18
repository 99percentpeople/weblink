// @vitest-environment node
import { expect, it } from "vitest";
import { RecordingMuxerWrites } from "@/libs/application/recording-muxer-writes";
it("keeps overlapping metadata updates in order and appends only new media bytes", () => {
  const target = new RecordingMuxerWrites();
  const parts = [
    target.write({
      position: 0,
      data: new Uint8Array([0, 0, 0, 0, 0, 0]),
    }),
    target.write({
      position: 1,
      data: new Uint8Array([1, 1, 1]),
    }),
    target.write({
      position: 2,
      data: new Uint8Array([2, 2]),
    }),
    target.write({
      position: 1,
      data: new Uint8Array([3]),
    }),
    target.write({
      position: 4,
      data: new Uint8Array([4, 4, 5, 5]),
    }),
  ];
  const final = new Uint8Array(
    parts.flatMap((part) => [...part]),
  );
  for (const patch of target.patches)
    final.set(patch.data, patch.offset);
  expect(final).toEqual(
    new Uint8Array([0, 3, 2, 2, 4, 4, 5, 5]),
  );
});
it("rejects sparse writes and bounds metadata retained until close", () => {
  const target = new RecordingMuxerWrites();
  expect(() =>
    target.write({ position: 1, data: new Uint8Array(1) }),
  ).toThrow("sparse");
  target.write({
    position: 0,
    data: new Uint8Array(1024 * 1024 + 1),
  });
  expect(() =>
    target.write({
      position: 0,
      data: new Uint8Array(1024 * 1024 + 1),
    }),
  ).toThrow("limit");
});
it("bounds muxer buffering if one track stalls, and releases credits as media is written", () => {
  const target = new RecordingMuxerWrites();
  target.accountPacket(8 * 1024 * 1024);
  target.write({ position: 0, data: new Uint8Array(1024) });
  target.accountPacket(1024);
  expect(() => target.accountPacket(1)).toThrow(
    "output stalled",
  );
});
