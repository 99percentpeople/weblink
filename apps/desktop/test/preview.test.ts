import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createRawPreview } from "../src/preview";

let listener: ((event: any) => void) | undefined;
const release = vi.fn();
const stop = vi.fn();
const requestFrame = vi.fn();
const draw = vi.fn();
let scheduled: (() => void) | undefined;
let shared: ArrayBuffer;
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers();
  listener = undefined;
  scheduled = undefined;
  shared = new ArrayBuffer(24);
  release.mockClear();
  stop.mockClear();
  requestFrame.mockClear();
  draw.mockClear();
  vi.stubGlobal("chrome", {
    webview: {
      addEventListener: (
        _: string,
        next: typeof listener,
      ) => {
        listener = next;
      },
      removeEventListener: () => {
        listener = undefined;
      },
      releaseBuffer: release,
    },
  });
  vi.stubGlobal(
    "VideoFrame",
    class MockVideoFrame {
      close = vi.fn();
      constructor(
        readonly buffer: ArrayBuffer,
        readonly settings: any,
      ) {}
      get displayWidth() {
        return this.settings.codedWidth;
      }
      get displayHeight() {
        return this.settings.codedHeight;
      }
      clone() {
        return new MockVideoFrame(
          this.buffer,
          this.settings,
        );
      }
    },
  );
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: () => void) => {
      scheduled = callback;
      return 1;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", () => {
    scheduled = undefined;
  });
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
        getAudioTracks: () => [],
      }),
    },
  );
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete (HTMLCanvasElement.prototype as any).captureStream;
});
it("presents raw frames, resizes without replacing the stream, and serializes requests across visibility changes", async () => {
  const calls: string[] = [];
  let sequence = 0;
  let pending: ((value: any) => void) | undefined;
  let inFlight = 0,
    peak = 0;
  mockIPC(async (command, args: any) => {
    calls.push(command);
    if (command === "capture_preview_open")
      listener?.({
        additionalData: {
          kind: "weblink-preview",
          id: args.previewId,
        },
        getBuffer: () => shared,
      });
    if (command === "capture_preview_frame") {
      if (++sequence === 1)
        return {
          sequence,
          width: 2,
          height: 2,
          timestamp: 1,
          colorSpace: {
            matrix: "bt709",
            primaries: "bt709",
            transfer: "iec61966-2-1",
            fullRange: true,
          },
        };
      peak = Math.max(peak, ++inFlight);
      const result = await new Promise((resolve) => {
        pending = resolve;
      });
      inFlight--;
      return result;
    }
  });
  const ended = vi.fn();
  const preview = await createRawPreview(
    "capture",
    false,
    ended,
  );
  expect(draw).toHaveBeenCalledOnce();
  expect(draw.mock.calls[0][0].settings.colorSpace).toEqual(
    {
      matrix: "bt709",
      primaries: "bt709",
      transfer: "iec61966-2-1",
      fullRange: true,
    },
  );
  expect(preview.stats()).toMatchObject({
    width: 2,
    height: 2,
    frames: 1,
  });
  document.dispatchEvent(new Event("visibilitychange"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(peak).toBe(1);
  pending?.({
    sequence: 2,
    width: 4,
    height: 2,
    timestamp: 2,
  });
  await tick();
  expect(preview.stats()).toMatchObject({
    width: 4,
    height: 2,
    frames: 2,
  });
  expect(requestFrame).toHaveBeenCalledTimes(2);
  preview.close();
  preview.close();
  await tick();
  expect(stop).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(shared);
  expect(
    calls.filter((c) => c === "capture_preview_close"),
  ).toHaveLength(1);
  expect(
    calls.some((c) => /offer|answer|ice/.test(c)),
  ).toBe(false);
  expect(ended).not.toHaveBeenCalled();
  expect(scheduled).toBeUndefined();
});
it("presents full-resolution RGB planes with identity color metadata", async () => {
  const colorSpace = {
    matrix: "rgb",
    primaries: "bt709",
    transfer: "iec61966-2-1",
    fullRange: true,
  };
  mockIPC(async (command, args: any) => {
    if (command === "capture_preview_open")
      listener?.({
        additionalData: {
          kind: "weblink-preview",
          id: args.previewId,
        },
        getBuffer: () => shared,
      });
    if (command === "capture_preview_frame")
      return {
        sequence: 1,
        width: 2,
        height: 2,
        timestamp: 1,
        format: "BGRA",
        colorSpace,
      };
  });
  const preview = await createRawPreview(
    "rgb",
    false,
    vi.fn(),
  );
  expect(draw.mock.calls[0][0].settings).toMatchObject({
    format: "BGRA",
    colorSpace,
  });
  preview.close();
  expect(release).toHaveBeenCalledOnce();
});

it("keeps the display clock armed during IPC without overlapping shared-buffer requests", async () => {
  let requests = 0;
  let finish!: (value: any) => void;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      listener?.({
        additionalData: {
          kind: "weblink-preview",
          id: args.previewId,
        },
        getBuffer: () => shared,
      });
    if (command === "capture_preview_frame") {
      requests++;
      if (requests === 1)
        return { sequence: 1, width: 2, height: 2 };
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  const preview = await createRawPreview(
    "capture",
    false,
    vi.fn(),
  );
  await tick();
  expect(requests).toBe(2);
  const animate = () => {
    expect(scheduled).toBeTypeOf("function");
    const callback = scheduled;
    scheduled = undefined;
    callback?.();
  };
  // Display ticks may happen while IPC is pending. They cannot overwrite the
  // shared buffer, and they must keep the following display tick armed.
  animate();
  animate();
  expect(requests).toBe(2);
  finish({ sequence: 2, width: 2, height: 2 });
  await tick();
  expect(requests).toBe(2);
  animate();
  await tick();
  expect(requests).toBe(3);
  preview.close();
  finish(null);
  await tick();
  expect(scheduled).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
});

it("keeps hidden preview ticks serialized and cancels them on close", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  let requests = 0;
  let finish!: (value: any) => void;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      listener?.({
        additionalData: {
          kind: "weblink-preview",
          id: args.previewId,
        },
        getBuffer: () => shared,
      });
    if (command === "capture_preview_frame") {
      if (++requests === 1)
        return { sequence: 1, width: 2, height: 2 };
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  const preview = await createRawPreview(
    "capture",
    false,
    vi.fn(),
  );
  await vi.advanceTimersByTimeAsync(64);
  expect(requests).toBe(2);
  finish({ sequence: 2, width: 2, height: 2 });
  await tick();
  await vi.advanceTimersByTimeAsync(16);
  expect(requests).toBe(3);
  preview.close();
  finish(null);
  await vi.advanceTimersByTimeAsync(64);
  expect(requests).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(release).toHaveBeenCalledOnce();
});
it("aborting an opening preview releases a late mapping before closing its native owner", async () => {
  const controller = new AbortController();
  let complete!: () => void;
  let id = "";
  const commands: string[] = [];
  mockIPC(async (command, args: any) => {
    commands.push(command);
    if (command === "capture_preview_open") {
      id = args.previewId;
      await new Promise<void>((resolve) => {
        complete = resolve;
      });
    }
  });
  const pending = createRawPreview(
    "capture",
    false,
    vi.fn(),
    controller.signal,
  );
  const failed = expect(pending).rejects.toThrow();
  await tick();
  controller.abort();
  await failed;
  expect(commands).toEqual(["capture_preview_open"]);
  listener?.({
    additionalData: { kind: "weblink-preview", id },
    getBuffer: () => shared,
  });
  expect(release).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledWith(shared);
  complete();
  await tick();
  expect(commands).toEqual([
    "capture_preview_open",
    "capture_preview_close",
  ]);
  expect(listener).toBeUndefined();
});

it("waits for a generated-track write before requesting another shared-memory frame", async () => {
  let finish!: () => void;
  const abort = vi.fn().mockResolvedValue(undefined);
  const releaseLock = vi.fn();
  const write = vi
    .fn()
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
  vi.stubGlobal(
    "MediaStreamTrackGenerator",
    class {
      stop = stop;
      writable = {
        getWriter: () => ({ write, abort, releaseLock }),
      };
    },
  );
  vi.stubGlobal(
    "MediaStream",
    class {
      constructor(private tracks: MediaStreamTrack[]) {}
      getVideoTracks() {
        return this.tracks;
      }
      getAudioTracks() {
        return [];
      }
    },
  );
  let sequence = 0;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      listener?.({
        additionalData: {
          kind: "weblink-preview",
          id: args.previewId,
        },
        getBuffer: () => shared,
      });
    if (command === "capture_preview_frame")
      return {
        sequence: ++sequence,
        width: 2,
        height: 2,
        timestamp: sequence,
      };
  });
  const ended = vi.fn();
  const preview = await createRawPreview(
    "capture",
    false,
    ended,
  );
  await tick();
  expect(sequence).toBe(2);
  expect(write).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(sequence).toBe(2);
  expect(draw).not.toHaveBeenCalled();
  preview.close();
  finish();
  await tick();
  expect(sequence).toBe(2);
  expect(abort).toHaveBeenCalledOnce();
  expect(releaseLock).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(ended).not.toHaveBeenCalled();
  expect(scheduled).toBeUndefined();
});
