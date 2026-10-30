import { afterEach, expect, it, vi } from "vitest";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("renders stereo PCM, bounds queued history and rejects malformed chunks", async () => {
  let Processor: any;
  vi.stubGlobal(
    "AudioWorkletProcessor",
    class {
      port: { onmessage?: Function } = {};
    },
  );
  vi.stubGlobal(
    "registerProcessor",
    (_name: string, value: any) => {
      Processor = value;
    },
  );
  // The worklet runs in its own browser realm, without TypeScript DOM bindings.
  // @ts-expect-error JavaScript AudioWorklet module
  await import("../src/receive-audio.worklet.js");
  const processor = new Processor();
  const push = (samples: number, value: number) =>
    processor.port.onmessage({
      data: new Int16Array(samples).fill(value).buffer,
    });
  push(3840, 8192);
  push(3840, 16384);
  processor.port.onmessage({ data: new ArrayBuffer(3) });
  push(3842, 30000);
  push(0, 0);
  expect(processor.samples).toBe(3840);
  const output = [
    new Float32Array(1922),
    new Float32Array(1922),
  ];
  expect(processor.process([], [output])).toBe(true);
  expect(output[0][0]).toBe(0.5);
  expect(output[1][1919]).toBe(0.5);
  expect(output[0][1920]).toBe(0);
  expect(processor.samples).toBe(0);
});
