// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import type { StoredFile } from "@weblink/platform";
import { createFileUrl } from "@/libs/hooks/create-file-url";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";

vi.mock("@/libs/utils/stored-file", () => ({
  fileObjectUrl: vi.fn(),
  revokeFileUrl: vi.fn(),
}));
const disposers: (() => void)[] = [];
beforeEach(() => vi.resetAllMocks());
afterEach(() =>
  disposers.splice(0).forEach((dispose) => dispose()),
);
function preview(file?: StoredFile) {
  return createRoot((dispose) => {
    disposers.push(dispose);
    const [source, setSource] = createSignal(file);
    return { ...createFileUrl(source), setSource, dispose };
  });
}

it("shows asynchronous URLs and releases them when unmounted", async () => {
  vi.mocked(fileObjectUrl).mockResolvedValue("blob:paged");
  const state = preview(new File([], "file"));
  expect(state.loading()).toBe(true);
  expect(state.url()).toBeUndefined();
  await Promise.resolve();
  expect(state.url()).toBe("blob:paged");
  expect(state.loading()).toBe(false);
  const signal = vi.mocked(fileObjectUrl).mock.calls[0][1]!;
  state.dispose();
  expect(signal.aborted).toBe(true);
  expect(revokeFileUrl).toHaveBeenCalledOnce();
  expect(revokeFileUrl).toHaveBeenCalledWith("blob:paged");
});

it("aborts stale reads and releases late URLs without replacing the current preview", async () => {
  let finish!: (url: string) => void;
  vi.mocked(fileObjectUrl)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockReturnValueOnce("blob:next");
  const state = preview(new File([], "old"));
  const signal = vi.mocked(fileObjectUrl).mock.calls[0][1]!;
  state.setSource(new File([], "next"));
  expect(signal.aborted).toBe(true);
  expect(state.url()).toBe("blob:next");
  finish("blob:stale");
  await Promise.resolve();
  expect(state.url()).toBe("blob:next");
  expect(revokeFileUrl).toHaveBeenCalledOnce();
  expect(revokeFileUrl).toHaveBeenCalledWith("blob:stale");
  state.dispose();
  expect(revokeFileUrl).toHaveBeenLastCalledWith(
    "blob:next",
  );
});

it("handles read failures and clears them when a new source is selected", async () => {
  const error = new Error("Storage unavailable");
  vi.mocked(fileObjectUrl)
    .mockRejectedValueOnce(error)
    .mockReturnValueOnce("blob:next");
  const state = preview(new File([], "old"));
  await Promise.resolve();
  expect(state.error()).toBe(error);
  expect(state.loading()).toBe(false);
  state.setSource(new File([], "next"));
  expect(state.error()).toBeUndefined();
  expect(state.url()).toBe("blob:next");
});

it("ignores cancelled read errors after disposal", async () => {
  let fail!: (reason: Error) => void;
  vi.mocked(fileObjectUrl).mockImplementation(
    () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  );
  const state = preview(new File([], "file"));
  state.dispose();
  fail(new Error("Cancelled"));
  await Promise.resolve();
  expect(state.error()).toBeUndefined();
  expect(state.url()).toBeUndefined();
  expect(revokeFileUrl).not.toHaveBeenCalled();
});
