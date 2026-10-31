import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { openPresentationRecording } from "../src/presentation-recording";
const presenter = vi.hoisted(() => ({
  stream: {},
  write: vi.fn(async () => {}),
  refresh: vi.fn(async (_force?: boolean) => true),
  close: vi.fn(),
}));
vi.mock("../src/preview-track", () => ({
  createPreviewTrack: () => presenter,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});
afterEach(() => {
  clearMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const tick = async () => {
  for (let n = 0; n < 20; n++) await Promise.resolve();
};
it("seeds only after recorder attachment and refreshes static pixels without another native frame", async () => {
  vi.stubGlobal(
    "VideoFrame",
    class {
      close() {}
    },
  );
  const bytes = new ArrayBuffer(30);
  const header = new DataView(bytes);
  header.setUint32(0, 2, true);
  header.setUint32(4, 2, true);
  header.setBigUint64(8, 1n, true);
  let reads = 0,
    copies = 0;
  mockIPC((command, args) => {
    if (command !== "presentation_frame") return;
    reads++;
    if (args?.after) return new ArrayBuffer(0);
    copies++;
    return bytes;
  });
  const recording = await openPresentationRecording(
    "static",
    () => false,
    new AbortController().signal,
    vi.fn(),
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(reads).toBe(1);
  expect(presenter.refresh).not.toHaveBeenCalled();
  let release!: () => void;
  presenter.refresh.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
  );
  const starting = recording.start();
  expect(recording.start()).toBe(starting);
  await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBe(1); // No racing writer while the initial replay is pending.
  release();
  await starting;
  await vi.advanceTimersByTimeAsync(1000);
  expect(presenter.refresh).toHaveBeenCalledWith(true);
  expect(presenter.refresh).toHaveBeenCalledWith();
  expect(copies).toBe(1);
  expect(presenter.write).toHaveBeenCalledOnce();
  recording.close();
  const calls = presenter.refresh.mock.calls.length;
  await vi.advanceTimersByTimeAsync(1000);
  expect(presenter.refresh).toHaveBeenCalledTimes(calls);
  expect(vi.getTimerCount()).toBe(0);
});
it("cancels a pending CPU read without publishing a late frame", async () => {
  let finish!: (value: ArrayBuffer) => void;
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "presentation_frame")
      return new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      });
  });
  const abort = new AbortController();
  const opening = openPresentationRecording(
    "surface",
    () => false,
    abort.signal,
    vi.fn(),
  );
  const failed = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  await tick();
  abort.abort();
  await failed;
  finish(new ArrayBuffer(0));
  await tick();
  expect(presenter.write).not.toHaveBeenCalled();
  expect(presenter.close).toHaveBeenCalledOnce();
  expect(commands).toEqual([
    "presentation_recording_open",
    "presentation_frame",
    "presentation_recording_close",
  ]);
});
it("keeps one read in flight and closes each independent VideoFrame", async () => {
  const closeFrame = vi.fn();
  vi.stubGlobal(
    "VideoFrame",
    class {
      close = closeFrame;
    },
  );
  const bytes = new ArrayBuffer(30);
  const header = new DataView(bytes);
  header.setUint32(0, 2, true);
  header.setUint32(4, 2, true);
  header.setBigUint64(8, 1n, true);
  let reads = 0;
  const sessions: unknown[] = [];
  mockIPC((command, args) => {
    sessions.push(args?.recordingId);
    if (command === "presentation_frame") {
      reads++;
      return bytes;
    }
  });
  let written!: () => void;
  presenter.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        written = resolve;
      }),
  );
  const abort = new AbortController();
  const opening = openPresentationRecording(
    "surface",
    () => false,
    abort.signal,
    vi.fn(),
  );
  await tick();
  await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBe(1);
  written();
  const recording = await opening;
  expect(closeFrame).toHaveBeenCalledOnce();
  recording.close();
  await vi.advanceTimersByTimeAsync(100);
  expect(reads).toBe(1);
  expect(presenter.close).toHaveBeenCalledOnce();
  expect(sessions).toHaveLength(3);
  expect(new Set(sessions).size).toBe(1);
  expect(typeof sessions[0]).toBe("string");
});

it("closes a cancelled opening only after native creation finishes", async () => {
  let created!: () => void;
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "presentation_recording_open")
      return new Promise<void>((resolve) => {
        created = resolve;
      });
  });
  const abort = new AbortController();
  const opening = openPresentationRecording(
    "surface",
    () => false,
    abort.signal,
    vi.fn(),
  );
  const failed = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  abort.abort();
  await failed;
  expect(commands).toEqual(["presentation_recording_open"]);
  created();
  await tick();
  expect(commands).toEqual([
    "presentation_recording_open",
    "presentation_recording_close",
  ]);
  expect(presenter.write).not.toHaveBeenCalled();
  expect(presenter.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("releases native buffers when a read fails", async () => {
  const ended = vi.fn();
  const commands: string[] = [];
  mockIPC((command) => {
    commands.push(command);
    if (command === "presentation_frame")
      throw new Error("Device removed");
  });
  await expect(
    openPresentationRecording(
      "surface",
      () => false,
      new AbortController().signal,
      ended,
    ),
  ).rejects.toThrow("Device removed");
  expect(commands).toEqual([
    "presentation_recording_open",
    "presentation_frame",
    "presentation_recording_close",
  ]);
  expect(ended).toHaveBeenCalledOnce();
  expect(presenter.close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps a replacement recording alive when a cancelled opening closes late", async () => {
  vi.stubGlobal(
    "VideoFrame",
    class {
      close() {}
    },
  );
  const bytes = new ArrayBuffer(30);
  const header = new DataView(bytes);
  header.setUint32(0, 2, true);
  header.setUint32(4, 2, true);
  header.setBigUint64(8, 1n, true);
  let created!: () => void;
  let oldId: unknown;
  const active = new Set<unknown>();
  mockIPC((command, args) => {
    const key = args?.recordingId;
    if (command === "presentation_recording_open") {
      active.add(key);
      if (!oldId) {
        oldId = key;
        return new Promise<void>((resolve) => {
          created = resolve;
        });
      }
    }
    if (command === "presentation_recording_close")
      active.delete(key);
    if (command === "presentation_frame") {
      expect(active.has(key)).toBe(true);
      return bytes;
    }
  });
  const abort = new AbortController();
  const opening = openPresentationRecording(
    "surface",
    () => false,
    abort.signal,
    vi.fn(),
  );
  const failed = expect(opening).rejects.toMatchObject({
    name: "AbortError",
  });
  abort.abort();
  await failed;
  const replacement = await openPresentationRecording(
    "surface",
    () => false,
    new AbortController().signal,
    vi.fn(),
  );
  expect(active.size).toBe(2);
  created();
  await tick();
  expect(active.size).toBe(1);
  expect(active.has(oldId)).toBe(false);
  replacement.close();
  await tick();
  expect(active.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
