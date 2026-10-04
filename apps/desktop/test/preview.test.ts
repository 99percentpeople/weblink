import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { createRawPreview } from "../src/preview";

let listener: ((event: any) => void) | undefined;
const release = vi.fn();
const stop = vi.fn();
const requestFrame = vi.fn();
const draw = vi.fn();
let scheduled: (() => void) | undefined;
let shared: ArrayBuffer;
let visibility: Channel<boolean> | undefined;
const openBuffer = (args: any, visible = true) => {
  visibility = args.visibility;
  visibility?.onmessage(visible);
  listener?.({
    additionalData: {
      kind: "weblink-preview",
      id: args.previewId,
    },
    getBuffer: () => shared,
  });
};
const tick = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve();
};
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance"],
  });
  listener = undefined;
  scheduled = undefined;
  visibility = undefined;
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
      openBuffer(args);
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
it("keeps the display clock armed during IPC without overlapping shared-buffer requests", async () => {
  let requests = 0;
  let finish!: (value: any) => void;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      openBuffer(args);
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

it("pauses native-hidden previews even if the document stays visible and resumes the same stream", async () => {
  vi.spyOn(document, "hidden", "get").mockReturnValue(
    false,
  );
  let requests = 0;
  let finish!: (value: any) => void;
  const calls: string[] = [];
  mockIPC((command, args: any) => {
    calls.push(command);
    if (command === "capture_preview_open")
      openBuffer(args);
    if (command === "capture_preview_frame") {
      if (++requests === 1)
        return { sequence: 1, width: 2, height: 2 };
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  const ended = vi.fn();
  const preview = await createRawPreview(
    "capture",
    false,
    ended,
  );
  const stream = preview.stream;
  expect(requests).toBe(2);
  visibility?.onmessage(false);
  expect(scheduled).toBeUndefined();
  // A frame already requested before hiding must not reach the presenter.
  finish({ sequence: 2, width: 2, height: 2 });
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests).toBe(2);
  expect(draw).toHaveBeenCalledOnce();
  expect(stop).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  visibility?.onmessage(true);
  expect(requests).toBe(3);
  finish({ sequence: 3, width: 4, height: 2 });
  await tick();
  expect(preview.stream).toBe(stream);
  expect(preview.stats()).toMatchObject({
    width: 4,
    frames: 2,
  });
  expect(scheduled).toBeTypeOf("function");
  preview.close();
  visibility?.onmessage(false);
  visibility?.onmessage(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(requests).toBe(3);
  expect(vi.getTimerCount()).toBe(0);
  expect(scheduled).toBeUndefined();
  expect(release).toHaveBeenCalledOnce();
  expect(ended).not.toHaveBeenCalled();
  expect(calls).toEqual([
    "capture_preview_open",
    "capture_preview_frame",
    "capture_preview_frame",
    "capture_preview_frame",
    "capture_preview_close",
  ]);
});
it.each(["native", "document"])(
  "opens while %s-hidden without waiting for a frame and starts on visibility restoration",
  async (hiddenBy) => {
    const hidden = vi
      .spyOn(document, "hidden", "get")
      .mockReturnValue(hiddenBy === "document");
    let requests = 0;
    mockIPC((command, args: any) => {
      if (command === "capture_preview_open")
        openBuffer(args, hiddenBy !== "native");
      if (command === "capture_preview_frame")
        return {
          sequence: ++requests,
          width: 2,
          height: 2,
        };
    });
    const ended = vi.fn();
    const preview = await createRawPreview(
      "capture",
      false,
      ended,
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(requests).toBe(0);
    expect(draw).not.toHaveBeenCalled();
    expect(scheduled).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    hidden.mockReturnValue(false);
    visibility?.onmessage(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await tick();
    expect(requests).toBe(1);
    expect(draw).toHaveBeenCalledOnce();
    expect(scheduled).toBeTypeOf("function");
    expect(ended).not.toHaveBeenCalled();
    preview.close();
    await tick();
  },
);
it("keeps requests serialized across rapid hide/show while IPC is pending", async () => {
  let requests = 0;
  let finish!: (value: any) => void;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      openBuffer(args);
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
  visibility?.onmessage(false);
  visibility?.onmessage(true);
  visibility?.onmessage(false);
  visibility?.onmessage(true);
  scheduled?.();
  expect(requests).toBe(2);
  finish({ sequence: 2, width: 2, height: 2 });
  await tick();
  scheduled?.();
  expect(requests).toBe(3);
  preview.close();
  finish(null);
  await tick();
});
it("finishes opening if the window hides while its first frame is pending", async () => {
  let finish!: (value: any) => void;
  let requests = 0;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      openBuffer(args);
    if (command === "capture_preview_frame") {
      requests++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }
  });
  const ended = vi.fn();
  const opening = createRawPreview("capture", false, ended);
  await tick();
  expect(requests).toBe(1);
  visibility?.onmessage(false);
  finish({ sequence: 1, width: 2, height: 2 });
  const preview = await opening;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(requests).toBe(1);
  expect(draw).not.toHaveBeenCalled();
  expect(ended).not.toHaveBeenCalled();
  expect(scheduled).toBeUndefined();
  visibility?.onmessage(true);
  expect(requests).toBe(2);
  finish({ sequence: 2, width: 2, height: 2 });
  await tick();
  expect(draw).toHaveBeenCalledOnce();
  preview.close();
  await tick();
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
      openBuffer(args);
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

it("pauses generated-track static refreshes while document-hidden and resumes while unfocused", async () => {
  const hidden = vi
    .spyOn(document, "hidden", "get")
    .mockReturnValue(false);
  const write = vi.fn().mockResolvedValue(undefined);
  const abort = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal(
    "MediaStreamTrackGenerator",
    class {
      stop = stop;
      writable = {
        getWriter: () => ({
          write,
          abort,
          releaseLock: vi.fn(),
        }),
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
  let requests = 0;
  mockIPC((command, args: any) => {
    if (command === "capture_preview_open")
      openBuffer(args);
    if (command === "capture_preview_frame") {
      if (++requests === 1)
        return { sequence: 1, width: 2, height: 2 };
      return null;
    }
  });
  const preview = await createRawPreview(
    "capture",
    false,
    vi.fn(),
  );
  await tick();
  expect(write).toHaveBeenCalledOnce();
  hidden.mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(requests).toBe(2);
  expect(write).toHaveBeenCalledOnce();
  expect(scheduled).toBeUndefined();
  expect(vi.getTimerCount()).toBe(0);
  expect(stop).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  vi.spyOn(document, "hasFocus").mockReturnValue(false);
  window.dispatchEvent(new Event("blur"));
  document.dispatchEvent(new Event("visibilitychange"));
  await tick();
  expect(requests).toBe(3);
  expect(write).toHaveBeenCalledTimes(2);
  expect(scheduled).toBeTypeOf("function");
  preview.close();
  await tick();
  expect(abort).toHaveBeenCalledOnce();
});
