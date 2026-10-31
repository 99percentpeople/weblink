import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import { createNativeScreenReceive } from "../src/receive";

const presenter = vi.hoisted(() => ({
  stream: { getAudioTracks: () => [], addTrack: vi.fn() },
  write: vi.fn(async (_frame: unknown) => {}),
  refresh: vi.fn(async () => false),
  needsRefresh: true,
  close: vi.fn(),
}));
vi.mock("../src/preview-track", () => ({
  createPreviewTrack: () => presenter,
}));
let listener: ((event: any) => void) | undefined;
let events: Channel<any>;
let visible: (visible: boolean) => void;
let id: string;
let shared: ArrayBuffer;
const release = vi.fn();
const unwatch = vi.fn();
const received = vi.fn();
const api = createNativeScreenReceive((callback) => {
  visible = callback;
  return unwatch;
});
const tick = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const openBuffer = (args: any) => {
  events = args.events;
  id = args.id;
  listener?.({
    additionalData: { kind: "weblink-receive", id },
    getBuffer: () => shared,
  });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  shared = new ArrayBuffer(24);
  presenter.write.mockImplementation(async () => {});
  presenter.needsRefresh = true;
  vi.stubGlobal("chrome", {
    webview: {
      addEventListener: (
        _: string,
        value: typeof listener,
      ) => {
        listener = value;
      },
      removeEventListener: () => {
        listener = undefined;
      },
      releaseBuffer: release,
    },
  });
  vi.stubGlobal(
    "VideoFrame",
    class {
      close = vi.fn();
      constructor(
        readonly pixels: ArrayBuffer,
        readonly options: unknown,
      ) {}
    },
  );
});
afterEach(() => {
  clearMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(["windows", "linux", "macos"])(
  "allows browser receiving only on unsupported native platforms: %s",
  async (os) => {
    mockIPC((command) => {
      if (command === "runtime_capabilities") return { os };
      if (command === "receive_codecs")
        return os === "windows" ? ["video/h265"] : [];
    });
    const receive = createNativeScreenReceive(
      () => () => {},
    );
    expect(receive.allowBrowserFallback).toBe(false);
    await receive.codecs();
    expect(receive.allowBrowserFallback).toBe(
      os !== "windows",
    );
  },
);

it("keeps Windows native-only when decoder discovery fails", async () => {
  mockIPC((command) => {
    if (command === "runtime_capabilities")
      return { os: "windows" };
    throw new Error("decoder discovery failed");
  });
  const receive = createNativeScreenReceive(() => () => {});
  await expect(receive.codecs()).rejects.toThrow(
    "decoder discovery failed",
  );
  expect(receive.allowBrowserFallback).toBe(false);
});

it("serializes shared-memory copies and skips accumulated frames while a write is pending", async () => {
  let copies = 0;
  let finish!: () => void;
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_frame")
      return copies++ === 0
        ? null
        : {
            sequence: copies,
            width: 4,
            height: 4,
            format: "NV12",
            colorSpace: { matrix: "bt709" },
          };
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  presenter.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  events.onmessage({ type: "frame" });
  await tick();
  for (let i = 0; i < 100; i++)
    events.onmessage({ type: "frame" });
  await tick();
  expect(copies).toBe(2);
  finish();
  await tick();
  expect(copies).toBe(3);
  expect(presenter.write).toHaveBeenCalledTimes(2);
  expect(received).toHaveBeenCalledExactlyOnceWith({
    type: "track",
  });
  expect(presenter.write.mock.calls[0][0]).toMatchObject({
    pixels: shared,
    options: {
      format: "NV12",
      colorSpace: { matrix: "bt709" },
    },
  });
  connection.close();
  await tick();
  expect(release).toHaveBeenCalledExactlyOnceWith(shared);
  expect(unwatch).toHaveBeenCalledOnce();
});

it("pauses presentation while hidden and requests the newest frame on restore", async () => {
  const commands: string[] = [];
  mockIPC((command, args: any) => {
    commands.push(command);
    if (command === "receive_open") openBuffer(args);
    return null;
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  visible(false);
  await tick();
  commands.length = 0;
  events.onmessage({ type: "frame" });
  await vi.advanceTimersByTimeAsync(1000);
  expect(commands).not.toContain("receive_frame");
  expect(presenter.refresh).not.toHaveBeenCalled();
  visible(true);
  await tick();
  expect(commands).toContain("receive_frame");
  connection.close();
  await tick();
});

it("refreshes only idle generated tracks without reading shared pixels again", async () => {
  let copies = 0;
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_frame") {
      copies++;
      return {
        sequence: copies,
        width: 4,
        height: 4,
        format: "NV12",
      };
    }
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  for (let i = 0; i < 10; i++) {
    await vi.advanceTimersByTimeAsync(100);
    events.onmessage({ type: "frame" });
    await tick();
  }
  expect(presenter.refresh).not.toHaveBeenCalled();
  const beforeIdle = copies;
  await vi.advanceTimersByTimeAsync(500);
  expect(presenter.refresh).toHaveBeenCalledOnce();
  expect(copies).toBe(beforeIdle);
  visible(false);
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(presenter.refresh).toHaveBeenCalledOnce();
  visible(true);
  await tick();
  expect(copies).toBe(beforeIdle + 1);
  connection.close();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not schedule repeat frames for the canvas presenter", async () => {
  presenter.needsRefresh = false;
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    return null;
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(presenter.refresh).not.toHaveBeenCalled();
  connection.close();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not publish a late track after closing during a presentation write", async () => {
  let finish!: () => void;
  presenter.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_frame")
      return {
        sequence: 1,
        width: 4,
        height: 4,
        format: "NV12",
      };
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  connection.close();
  finish();
  await tick();
  expect(received).not.toHaveBeenCalledWith({
    type: "track",
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending open, releases a late buffer, then closes the native owner", async () => {
  let finish!: () => void;
  let args: any;
  const closed = vi.fn();
  mockIPC((command, value: any) => {
    if (command === "receive_open") {
      args = value;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    }
    if (command === "receive_close") closed();
  });
  const controller = new AbortController();
  const opening = api.open({}, received, controller.signal);
  controller.abort();
  await expect(opening).rejects.toThrow("Receiver closed");
  expect(closed).not.toHaveBeenCalled();
  openBuffer(args);
  finish();
  await tick();
  expect(release).toHaveBeenCalledExactlyOnceWith(shared);
  expect(closed).toHaveBeenCalledOnce();
  expect(listener).toBeUndefined();
});

it("reports invalid native frames and releases the connection for browser fallback", async () => {
  const closed = vi.fn();
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_frame")
      return {
        sequence: 1,
        width: 4000,
        height: 2160,
        format: "NV12",
      };
    if (command === "receive_close") closed();
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  expect(received).toHaveBeenCalledWith({
    type: "error",
    error: expect.stringContaining(
      "Invalid native receive frame",
    ),
  });
  expect(presenter.write).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledOnce();
  connection.close();
  expect(presenter.close).toHaveBeenCalledOnce();
});

it("keeps audio in the bounded native queue until autoplay resumes on user input", async () => {
  let context: any;
  const postMessage = vi.fn();
  const read = vi.fn();
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "suspended";
      onstatechange?: () => void;
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamDestination = () => ({
        stream: {
          getAudioTracks: () => [{ kind: "audio" }],
        },
      });
      resume = vi.fn(async () => {});
      close = vi.fn(async () => {});
      constructor() {
        context = this;
      }
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { postMessage };
      connect() {}
      disconnect() {}
    },
  );
  mockIPC((command, args: any) => {
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_audio") {
      read();
      return new ArrayBuffer(1920);
    }
    return null;
  });
  const connection = await api.open(
    {},
    received,
    new AbortController().signal,
  );
  await tick();
  events.onmessage({ type: "audio-track" });
  events.onmessage({ type: "audio" });
  await tick();
  expect(read).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
  document.dispatchEvent(new Event("pointerdown"));
  expect(context.resume).toHaveBeenCalledTimes(2);
  context.state = "running";
  context.onstatechange();
  await tick();
  expect(read).toHaveBeenCalledOnce();
  expect(postMessage).toHaveBeenCalledOnce();
  connection.close();
  await tick();
  expect(context.close).toHaveBeenCalledOnce();
});
