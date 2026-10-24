// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { File } from "node:buffer";
import { invoke } from "@tauri-apps/api/core";
import { RangeFile } from "@weblink/platform";
import { openNativeFile } from "../src/open-file";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it.each([
  "weblink-file://localhost/opaque-id",
  "http://weblink-file.localhost/opaque-id",
  "https://weblink-file.localhost/opaque-id",
])(
  "opens the original native file without copying its bytes: %s",
  async (url) => {
    const read = vi.fn();
    const file = new RangeFile(
      "report.pdf",
      20_000_000,
      "application/pdf",
      0,
      read,
      url,
    );
    await openNativeFile(file);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith("vfs_open_file", {
      id: "opaque-id",
    });
    expect(read).not.toHaveBeenCalled();
  },
);

it("stages legacy files in bounded chunks and opens only after all bytes have arrived", async () => {
  const file = new File(
    [new Uint8Array(2 * 1024 * 1024 + 7).fill(42)],
    "旧文件.txt",
  );
  const chunks: Uint8Array[] = [];
  const commands: string[] = [];
  let offset = 0;
  vi.mocked(invoke).mockImplementation(
    async (command, args, options) => {
      commands.push(command);
      if (command === "file_open_begin") {
        expect(args).toEqual({
          name: file.name,
          size: file.size,
        });
        return "open-id";
      }
      if (command === "file_save_write") {
        expect(options?.headers).toEqual({
          "x-save-id": "open-id",
          "x-save-offset": String(offset),
        });
        const bytes = new Uint8Array(args as ArrayBuffer);
        expect(bytes.length).toBeLessThanOrEqual(
          1024 * 1024,
        );
        chunks.push(bytes);
        offset += bytes.length;
      } else {
        expect(command).toBe("file_save_finish");
        expect(offset).toBe(file.size);
      }
    },
  );
  await openNativeFile(file);
  expect(commands).not.toContain("file_save_begin");
  expect(commands.at(-1)).toBe("file_save_finish");
  expect(
    Buffer.concat(chunks).equals(
      Buffer.from(await file.arrayBuffer()),
    ),
  ).toBe(true);
});

it("removes partial temporary copies on failure without opening or showing a save picker", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "file_open_begin") return "open-id";
    if (command === "file_save_write")
      throw new Error("Disk full");
  });
  await expect(
    openNativeFile(new File(["data"], "file.txt")),
  ).rejects.toThrow("Disk full");
  expect(
    vi
      .mocked(invoke)
      .mock.calls.map(([command]) => command),
  ).toEqual([
    "file_open_begin",
    "file_save_write",
    "file_save_abort",
  ]);
});

it("does not fall back to a copied file when its native capability is stale", async () => {
  vi.mocked(invoke).mockRejectedValue(
    new Error("File changed"),
  );
  await expect(
    openNativeFile(
      new RangeFile(
        "file.txt",
        4,
        "text/plain",
        0,
        vi.fn(),
        "weblink-file://localhost/stale",
      ),
    ),
  ).rejects.toThrow("File changed");
  expect(invoke).toHaveBeenCalledOnce();
});

it.each([
  "https://example.com/file",
  "file:///etc/passwd",
  "weblink-file://other/token",
  "http://weblink-file.localhost/token?path=/etc/passwd",
])("rejects non-capability URLs: %s", async (url) => {
  await expect(
    openNativeFile(
      new RangeFile("file.txt", 0, "", 0, vi.fn(), url),
    ),
  ).rejects.toThrow();
  expect(invoke).not.toHaveBeenCalled();
});
