// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { createEncodedRecording } from "@/libs/application/recording-encoded";
import type {
  EncodedVideoPacket,
  EncodedVideoSource,
} from "@/libs/domain/encoded-video";
const stream = {
  getAudioTracks: () => [],
} as unknown as MediaStream;
const packet: EncodedVideoPacket = {
  data: new ArrayBuffer(1),
  type: "key",
  timestamp: 0,
  mimeType: "video/H266",
  width: 640,
  height: 360,
  ssrc: 1,
  spatialIndex: 0,
  segment: 1,
};
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function source(emit = true, value = packet) {
  const stop = vi.fn(async () => {});
  const source: EncodedVideoSource = {
    subscribe(consumer) {
      return {
        pause() {},
        resume() {
          if (emit)
            queueMicrotask(() => {
              void consumer.frame(value);
            });
        },
        stop,
      };
    },
  };
  return { source, stop };
}
it("releases unsupported encoded sources and returns control to the existing recorder", async () => {
  const first = source(),
    second = source();
  expect(
    await createEncodedRecording(
      [first.source, second.source],
      stream,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(first.stop).toHaveBeenCalledOnce();
  expect(second.stop).toHaveBeenCalledOnce();
});
it("times out missing keyframes and releases the subscription for fallback", async () => {
  vi.useFakeTimers();
  const f = source(false);
  const result = createEncodedRecording(
    [f.source],
    stream,
    new AbortController().signal,
  );
  await vi.advanceTimersByTimeAsync(2501);
  expect(await result).toBeUndefined();
  expect(f.stop).toHaveBeenCalledOnce();
});
it("cancels preparation without starting fallback recording", async () => {
  const f = source(false);
  const controller = new AbortController();
  const result = createEncodedRecording(
    [f.source],
    stream,
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  expect(f.stop).toHaveBeenCalledOnce();
});
it("falls back without starting a sender subscription when mixed audio cannot be processed", async () => {
  vi.stubGlobal("MediaStreamTrackProcessor", undefined);
  const subscribe = vi.fn();
  expect(
    await createEncodedRecording(
      [{ subscribe }],
      {
        getAudioTracks: () => [{}],
      } as unknown as MediaStream,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(subscribe).not.toHaveBeenCalled();
});

it("rejects malformed HEVC parameter sets during preparation so the existing recorder can take over", async () => {
  const { hevcKeyframe } =
    await import("../fixtures/recording-packets");
  const { avcUnits } =
    await import("@/libs/application/recording-encoded-format");
  const original = Uint8Array.from(
    atob(hevcKeyframe),
    (c) => c.charCodeAt(0),
  );
  const units = avcUnits(original).map((unit) =>
    ((unit[0] >> 1) & 63) === 33
      ? unit.subarray(0, 20)
      : unit,
  );
  const data = new Uint8Array(
    units.reduce((size, unit) => size + 4 + unit.length, 0),
  );
  let offset = 0;
  for (const unit of units) {
    data.set([0, 0, 0, 1], offset);
    data.set(unit, offset + 4);
    offset += unit.length + 4;
  }
  const f = source(true, {
    ...packet,
    mimeType: "video/h265",
    data: data.buffer,
  });
  expect(
    await createEncodedRecording(
      [f.source],
      stream,
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(f.stop).toHaveBeenCalledOnce();
});
