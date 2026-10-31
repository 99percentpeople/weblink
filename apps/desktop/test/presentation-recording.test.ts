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
it("cancels a pending CPU read without publishing a late frame", async () => {
  let finish!: (value: ArrayBuffer) => void;
  mockIPC(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      }),
  );
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
  finish(new ArrayBuffer(0));
  await tick();
  expect(presenter.write).not.toHaveBeenCalled();
  expect(presenter.close).toHaveBeenCalledOnce();
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
  mockIPC(() => {
    reads++;
    return bytes;
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
});
