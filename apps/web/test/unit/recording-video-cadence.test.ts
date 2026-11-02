// @vitest-environment node
import { EncodedPacket } from "mediabunny";
import { expect, it } from "vitest";
import { RecordingVideoCadence } from "@/libs/application/recording-video-cadence";

const packet = (time: number, size = 1) =>
  new EncodedPacket(new Uint8Array(size), "delta", time, 0);

it("paces a 120 fps recording sampled on a 155 Hz display without losing frames or drifting from capture", () => {
  const input = Array.from({ length: 241 }, (_, i) =>
    packet(Math.round((i * 155) / 120) / 155),
  );
  const cadence = new RecordingVideoCadence();
  const output = input.flatMap((p) => cadence.add(p));
  output.push(...cadence.drain());
  expect(output).toHaveLength(input.length);
  expect(output[0].timestamp).toBe(0);
  expect(output.at(-1)!.timestamp).toBe(2);
  for (const [i, frame] of output.entries()) {
    expect(frame.data).toBe(input[i].data);
    if (!i) continue;
    const ticks = Math.round(frame.timestamp * 1000);
    const previous = Math.round(
      output[i - 1].timestamp * 1000,
    );
    expect(ticks - previous).toBeGreaterThanOrEqual(7);
    expect(
      Math.abs(frame.timestamp - input[i].timestamp),
    ).toBeLessThan(0.005);
  }
});

it("keeps both edges of a static hold, slow updates and resumed segments on the capture clock", () => {
  const cadence = new RecordingVideoCadence();
  function segment(times: number[]) {
    return [
      ...times.flatMap((t) => cadence.add(packet(t))),
      ...cadence.drain(),
    ].map((p) => p.timestamp);
  }
  const first = segment([
    0, 0.006, 0.013, 0.026, 0.032, 18, 18.21, 18.216,
    18.229,
  ]);
  expect(first.slice(4, 7)).toEqual([0.032, 18, 18.21]);
  expect(first.at(-1)).toBe(18.229);
  const second = segment([18.236, 18.249, 18.255]);
  expect(second[0]).toBe(18.236);
  expect(second.at(-1)).toBe(18.255);
  expect(cadence.drain()).toEqual([]);
});

it.each([30, 120, 240])(
  "leaves an already regular %i fps recording on its clock",
  (rate) => {
    const cadence = new RecordingVideoCadence();
    const times = Array.from(
      { length: 30 },
      (_, i) => 2.5 + i / rate,
    );
    const result = [
      ...times.flatMap((t) => cadence.add(packet(t))),
      ...cadence.drain(),
    ];
    expect(result).toHaveLength(times.length);
    result.forEach((p, i) =>
      expect(p.timestamp).toBeCloseTo(times[i], 10),
    );
  },
);

it("drains retained data in order before a large access unit and preserves a lone frame", () => {
  const cadence = new RecordingVideoCadence();
  const first = packet(1);
  expect(cadence.add(first)).toEqual([first]);
  expect(cadence.drain()).toEqual([]);
  const small = [packet(2), packet(2.006), packet(2.013)];
  const large = packet(2.026, 2 * 1024 * 1024 + 1);
  const frames = small.flatMap((p) => cadence.add(p));
  frames.push(...cadence.add(large));
  const input = [...small, large];
  expect(frames).toHaveLength(input.length);
  frames.forEach((p, i) =>
    expect(p.data).toBe(input[i].data),
  );
  expect(frames.at(-2)?.timestamp).toBe(
    small.at(-1)?.timestamp,
  );
  expect(frames.at(-1)).toBe(large);
  expect(cadence.drain()).toEqual([]);
});
