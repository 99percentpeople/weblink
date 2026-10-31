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
let second: ArrayBuffer;
const postMessage = vi.fn();
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
  for (const [slot, buffer] of [shared, second].entries())
    listener?.({
      additionalData: {
        kind: "weblink-receive",
        id,
        slot,
        slots: 2,
      },
      getBuffer: () => buffer,
    });
};
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  shared = new ArrayBuffer(24);
  second = new ArrayBuffer(24);
  postMessage.mockImplementation(() => {});
  (window as any).__WEBLINK_RECEIVE_RELEASE__ = postMessage;
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
      postMessage,
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

it("opens GPU receiving without shared buffers or browser decoding", async () => {
  vi.stubGlobal("chrome", undefined);
  vi.stubGlobal("VideoFrame", undefined);
  const surface = {
    stream: presenter.stream,
    open: vi.fn(async () => {}),
    close: vi.fn(),
    stats: vi.fn(async () => ({
      path: "d3d11-composition",
    })),
  };
  const create = vi.fn(() => surface);
  const calls: { command: string; args: any }[] = [];
  mockIPC((command, args) => {
    calls.push({ command, args });
  });
  const native = createNativeScreenReceive(() => () => {}, {
    create,
  } as any);
  const abort = new AbortController();
  const connection = await native.open(
    {},
    vi.fn(),
    abort.signal,
  );
  expect(connection.stream).toBe(surface.stream);
  expect(surface.open).toHaveBeenCalledOnce();
  expect(
    calls.find((c) => c.command === "receive_open")?.args
      .gpu,
  ).toBe(true);
  expect(native.allowBrowserFallback).toBe(false);
  abort.abort();
  await tick();
  expect(surface.close).toHaveBeenCalledOnce();
  expect(presenter.write).not.toHaveBeenCalled();
  expect(
    calls.filter((c) => c.command === "receive_close"),
  ).toHaveLength(1);
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

const frame = (lease: number, slot = (lease - 1) % 2) => ({
  type: "frame",
  lease,
  slot,
  frame: {
    sequence: lease,
    width: 4,
    height: 4,
    format: "NV12",
    colorSpace: { matrix: "bt709" },
  },
});
const open = async () => {
  const commands: string[] = [];
  mockIPC((command, args: any) => {
    commands.push(command);
    if (command === "receive_open") openBuffer(args);
    if (command === "receive_stats")
      return [
        {
          id: "video",
          type: "inbound-rtp",
          kind: "video",
          nativeReceive: { mode: "push", slots: 2 },
        },
      ];
  });
  return {
    commands,
    connection: await api.open(
      {},
      received,
      new AbortController().signal,
    ),
  };
};
const returned = () =>
  postMessage.mock.calls.flatMap(
    ([, releases]) => releases,
  );

it("returns copied slots before a slow writer settles and coalesces only unconstructed frames", async () => {
  let finish!: () => void;
  presenter.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { connection, commands } = await open();
  events.onmessage(frame(1));
  await tick();
  expect(returned()).toEqual([{ slot: 0, lease: 1 }]);
  expect(presenter.write).toHaveBeenCalledTimes(1);
  events.onmessage(frame(2));
  events.onmessage(frame(3));
  await tick();
  expect(returned()).toEqual([
    { slot: 0, lease: 1 },
    { slot: 1, lease: 2 },
  ]);
  expect(presenter.write).toHaveBeenCalledTimes(1);
  finish();
  await tick();
  expect(presenter.write).toHaveBeenCalledTimes(2);
  expect(returned()).toEqual([
    { slot: 0, lease: 1 },
    { slot: 1, lease: 2 },
    { slot: 0, lease: 3 },
  ]);
  expect(commands).not.toContain("receive_frame");
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
  const stats = await connection.stats();
  expect(stats[0].nativeReceive).toMatchObject({
    mode: "push",
    slots: 2,
    renderer: {
      receivedFrames: 3,
      submittedFrames: 2,
      coalescedFrames: 1,
      videoFrameCreateMs: { count: 2 },
      presenterWriteMs: { count: 2 },
    },
  });
  connection.close();
  await tick();
  expect(release).toHaveBeenCalledTimes(2);
  expect(unwatch).toHaveBeenCalledOnce();
});

it("keeps submitted pixels immutable when a returned native slot is reused", async () => {
  // Model the ownership distinction in WebCodecs: transfer may retain the
  // original backing store, while construction without transfer copies it.
  vi.stubGlobal(
    "VideoFrame",
    class {
      readonly pixels: ArrayBuffer;
      close = vi.fn();
      constructor(
        buffer: ArrayBuffer,
        options: { transfer?: ArrayBuffer[] },
      ) {
        this.pixels = options.transfer?.includes(buffer)
          ? buffer
          : buffer.slice(0);
      }
    },
  );
  let finish!: () => void;
  presenter.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { connection } = await open();
  new Uint8Array(shared).fill(64);
  events.onmessage(frame(1));
  await tick();
  expect(returned()).toEqual([{ slot: 0, lease: 1 }]);
  const submitted = presenter.write.mock.calls[0][0] as {
    pixels: ArrayBuffer;
  };
  new Uint8Array(shared).fill(96);
  events.onmessage(frame(3, 0));
  await tick();
  expect(new Uint8Array(submitted.pixels)).toEqual(
    new Uint8Array(24).fill(64),
  );
  finish();
  await tick();
  const next = presenter.write.mock.calls[1][0] as {
    pixels: ArrayBuffer;
  };
  expect(new Uint8Array(next.pixels)).toEqual(
    new Uint8Array(24).fill(96),
  );
  expect(new Uint8Array(submitted.pixels)).toEqual(
    new Uint8Array(24).fill(64),
  );
  connection.close();
  await tick();
});

it("discards and returns hidden frames, then accepts a native replay on restore", async () => {
  const { connection, commands } = await open();
  visible(false);
  await tick();
  events.onmessage(frame(1));
  await tick();
  expect(presenter.write).not.toHaveBeenCalled();
  expect(returned()).toEqual([{ slot: 0, lease: 1 }]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(presenter.refresh).not.toHaveBeenCalled();
  visible(true);
  await tick();
  const replay = frame(2);
  replay.frame.sequence = 1;
  events.onmessage(replay);
  await tick();
  expect(presenter.write).toHaveBeenCalledOnce();
  expect(
    commands.filter((c) => c === "receive_visible"),
  ).toHaveLength(3);
  connection.close();
  await tick();
});

it("ignores delayed duplicate leases without returning the newer slot twice", async () => {
  const { connection } = await open();
  events.onmessage(frame(1));
  await tick();
  events.onmessage(frame(2));
  await tick();
  events.onmessage(frame(1));
  await tick();
  expect(presenter.write).toHaveBeenCalledTimes(2);
  expect(returned()).toEqual([
    { slot: 0, lease: 1 },
    { slot: 1, lease: 2 },
  ]);
  connection.close();
  await tick();
});

it("refreshes idle generated tracks without pulling or recopying shared pixels", async () => {
  const { connection, commands } = await open();
  for (let i = 1; i <= 10; i++) {
    await vi.advanceTimersByTimeAsync(100);
    events.onmessage(frame(i));
    await tick();
  }
  expect(presenter.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(presenter.refresh).toHaveBeenCalledOnce();
  expect(presenter.write).toHaveBeenCalledTimes(10);
  expect(commands).not.toContain("receive_frame");
  visible(false);
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(presenter.refresh).toHaveBeenCalledOnce();
  connection.close();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not schedule refreshes for a canvas presenter", async () => {
  presenter.needsRefresh = false;
  const { connection } = await open();
  events.onmessage(frame(1));
  await tick();
  await vi.advanceTimersByTimeAsync(2000);
  expect(presenter.refresh).not.toHaveBeenCalled();
  connection.close();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not publish a late track after closing during a writer wait", async () => {
  let finish!: () => void;
  presenter.write.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { connection } = await open();
  events.onmessage(frame(1));
  await tick();
  events.onmessage(frame(2));
  await tick();
  connection.close();
  finish();
  await tick();
  expect(received).not.toHaveBeenCalledWith({
    type: "track",
  });
  expect(presenter.write).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels a pending open, releases both late mappings, then closes native ownership", async () => {
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
  expect(release).toHaveBeenCalledTimes(2);
  expect(closed).toHaveBeenCalledOnce();
  expect(listener).toBeUndefined();
});

it("fails native presentation on invalid descriptors and releases both buffers", async () => {
  const { connection } = await open();
  const invalid = frame(1);
  invalid.frame.width = 4000;
  events.onmessage(invalid);
  await tick();
  expect(received).toHaveBeenCalledWith({
    type: "error",
    error: expect.stringContaining(
      "Invalid native receive frame",
    ),
  });
  expect(presenter.write).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(2);
  connection.close();
  expect(presenter.close).toHaveBeenCalledOnce();
});

it("closes a connection whose one-way release transport fails", async () => {
  postMessage.mockImplementation(() => {
    throw new Error("WebView closed");
  });
  const { connection } = await open();
  events.onmessage(frame(1));
  await tick();
  expect(received).toHaveBeenCalledWith({
    type: "error",
    error: expect.stringContaining("WebView closed"),
  });
  expect(release).toHaveBeenCalledTimes(2);
  connection.close();
  await tick();
  expect(vi.getTimerCount()).toBe(0);
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
