// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { saveNativeFile } from "../src/save-file";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it("writes a large file in bounded binary chunks with exact offsets and content", async () => {
  const bytes = Uint8Array.from(
    { length: 2 * 1024 * 1024 + 23 },
    (_, index) => index % 251,
  );
  const chunks: Uint8Array[] = [];
  let offset = 0;
  vi.mocked(invoke).mockImplementation(
    async (command, args, options) => {
      if (command === "file_save_begin") {
        expect(args).toEqual({
          name: "received.zip",
          size: bytes.length,
          automatic: false,
        });
        return "save-id";
      }
      if (command === "file_save_write") {
        expect(args).toBeInstanceOf(ArrayBuffer);
        const chunk = new Uint8Array(args as ArrayBuffer);
        expect(chunk.length).toBeLessThanOrEqual(
          1024 * 1024,
        );
        expect(options?.headers).toEqual({
          "x-save-id": "save-id",
          "x-save-offset": String(offset),
        });
        offset += chunk.length;
        chunks.push(chunk);
      } else {
        expect(command).toBe("file_save_finish");
        expect(offset).toBe(bytes.length);
      }
    },
  );
  await expect(
    saveNativeFile(new Blob([bytes]), "received.zip"),
  ).resolves.toBe(true);
  expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
});

it("treats picker cancellation as a normal result and sends no file bytes", async () => {
  vi.mocked(invoke).mockResolvedValue(null);
  await expect(
    saveNativeFile(new Blob(["content"]), "file.txt"),
  ).resolves.toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
});

it("cleans up after a write failure and allows the next queued save", async () => {
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    commands.push(command);
    if (command === "file_save_begin") return "save-id";
    if (command === "file_save_write")
      throw new Error("Disk full");
  });
  const first = saveNativeFile(
    new Blob(["content"]),
    "failed.txt",
  );
  const second = saveNativeFile(new Blob([]), "empty.txt", {
    automatic: true,
  });
  await expect(first).rejects.toThrow("Disk full");
  await expect(second).resolves.toBe(true);
  expect(commands).toEqual([
    "file_save_begin",
    "file_save_write",
    "file_save_abort",
    "file_save_begin",
    "file_save_finish",
  ]);
  expect(invoke).toHaveBeenCalledWith("file_save_begin", {
    name: "empty.txt",
    size: 0,
    automatic: true,
  });
});

it("aborts if finalizing the destination fails", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "file_save_begin") return "save-id";
    if (command === "file_save_finish")
      throw new Error("Access denied");
  });
  await expect(
    saveNativeFile(new Blob([]), "file.txt"),
  ).rejects.toThrow("Access denied");
  expect(invoke).toHaveBeenLastCalledWith(
    "file_save_abort",
    { id: "save-id" },
  );
});

it("waits for the first picker before opening the next one", async () => {
  let cancel!: (value: null) => void;
  const firstPicker = new Promise<null>((resolve) => {
    cancel = resolve;
  });
  vi.mocked(invoke)
    .mockReturnValueOnce(firstPicker)
    .mockResolvedValue(null);
  const first = saveNativeFile(new Blob([]), "first.txt");
  const second = saveNativeFile(new Blob([]), "second.txt");
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledTimes(1),
  );
  cancel(null);
  await Promise.all([first, second]);
  expect(invoke).toHaveBeenCalledTimes(2);
});
