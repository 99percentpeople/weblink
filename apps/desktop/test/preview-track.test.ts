import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createPreviewTrack } from "../src/preview-track";

const allocated: Frame[] = [];
class Frame {
  displayWidth: number;
  displayHeight: number;
  timestamp: number;
  closed = false;
  close = vi.fn(() => {
    this.closed = true;
  });
  constructor(
    source: Frame | null,
    options: { timestamp: number },
  ) {
    this.displayWidth = source?.displayWidth ?? 1920;
    this.displayHeight = source?.displayHeight ?? 1080;
    this.timestamp = options.timestamp;
    allocated.push(this);
  }
  clone() {
    return new Frame(this, { timestamp: this.timestamp });
  }
}
const received: Frame[] = [];
let delayWrite: Promise<void> | undefined;
let writable: WritableStream<VideoFrame>;
const abort = vi.fn();
const stop = vi.fn();
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
const frame = (at = 0) =>
  new Frame(null, {
    timestamp: at * 1000,
  }) as unknown as VideoFrame;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  allocated.length = received.length = 0;
  delayWrite = undefined;
  abort.mockClear();
  stop.mockClear();
  vi.stubGlobal("VideoFrame", Frame);
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(private tracks: MediaStreamTrack[]) {}
      getVideoTracks() {
        return this.tracks;
      }
    },
  );
  vi.stubGlobal(
    "MediaStreamTrackGenerator",
    class {
      stop = stop;
      writable: WritableStream<VideoFrame>;
      constructor() {
        writable = this.writable = new WritableStream({
          write(input) {
            received.push(input as unknown as Frame);
            input.close();
            return delayWrite;
          },
          abort,
        });
      }
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("feeds VideoFrames without Canvas and retains only the latest pixels across size changes", async () => {
  const canvas = vi.spyOn(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  const preview = createPreviewTrack();
  const stream = preview.stream;
  const first = frame();
  await preview.write(first);
  expect(received).toEqual([first]);
  expect(canvas).not.toHaveBeenCalled();
  const retained = allocated.find((f) => !f.closed)!;
  expect(retained).toBeDefined();
  const next = frame(10);
  (next as unknown as Frame).displayWidth = 640;
  (next as unknown as Frame).displayHeight = 360;
  await preview.write(next);
  expect(retained.closed).toBe(true);
  expect(allocated.filter((f) => !f.closed)).toHaveLength(
    1,
  );
  expect(preview.stream).toBe(stream);
  expect(received[1].displayWidth).toBe(640);
  // Capture's wrapper must not be called recursively by presenter disposal.
  stream.getVideoTracks()[0].stop = vi.fn();
  preview.close();
  preview.close();
  await tick();
  expect(stop).toHaveBeenCalledOnce();
  expect(abort).toHaveBeenCalledOnce();
  expect(writable.locked).toBe(false);
  expect(allocated.every((f) => f.closed)).toBe(true);
});

it("refreshes static content sparsely for newly attached players, with fresh timestamps", async () => {
  const preview = createPreviewTrack();
  await preview.write(frame());
  await vi.advanceTimersByTimeAsync(499);
  expect(await preview.refresh()).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await preview.refresh()).toBe(true);
  expect(received).toHaveLength(2);
  expect(received[1].timestamp).toBe(500_000);
  expect(received[1].displayWidth).toBe(1920);
  expect(await preview.refresh()).toBe(false);
  expect(allocated.filter((f) => !f.closed)).toHaveLength(
    1,
  );
  preview.close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(await preview.refresh()).toBe(false);
  expect(received).toHaveLength(2);
  expect(allocated.every((f) => f.closed)).toBe(true);
});

it("keeps a pending submission pending and disposes its retained frame on stop", async () => {
  let finish!: () => void;
  delayWrite = new Promise((resolve) => {
    finish = resolve;
  });
  const preview = createPreviewTrack();
  let done = false;
  const writing = preview.write(frame()).then(() => {
    done = true;
  });
  await tick();
  expect(done).toBe(false);
  preview.close();
  expect(allocated.every((f) => f.closed)).toBe(true);
  finish();
  await writing;
  await tick();
  expect(writable.locked).toBe(false);
  const late = frame(1000);
  await expect(preview.write(late)).rejects.toMatchObject({
    name: "AbortError",
  });
  late.close();
  expect(received).toHaveLength(1);
});

it("falls back to Canvas if the generator cannot initialize", async () => {
  vi.stubGlobal(
    "MediaStreamTrackGenerator",
    class {
      constructor() {
        throw new Error("Unavailable runtime API");
      }
    },
  );
  const draw = vi.fn();
  const requestFrame = vi.fn();
  vi.spyOn(
    HTMLCanvasElement.prototype,
    "getContext",
  ).mockReturnValue({ drawImage: draw } as any);
  Object.defineProperty(
    HTMLCanvasElement.prototype,
    "captureStream",
    {
      configurable: true,
      value: () => ({
        getVideoTracks: () => [{ stop, requestFrame }],
      }),
    },
  );
  try {
    const preview = createPreviewTrack();
    const input = frame();
    await preview.write(input);
    input.close();
    expect(preview.implementation).toBe(
      "Shared memory / Canvas",
    );
    expect(draw).toHaveBeenCalledWith(input, 0, 0);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(await preview.refresh()).toBe(false);
    preview.close();
    preview.close();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    delete (HTMLCanvasElement.prototype as any)
      .captureStream;
  }
});
