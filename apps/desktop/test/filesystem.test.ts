// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { LocalFileSystemError } from "@weblink/platform";
import { nativeFileSystem } from "../src/filesystem";
import { saveNativeFile } from "../src/save-file";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (token: string) =>
    `weblink-file://localhost/${token}`,
  Channel: class {},
}));
afterEach(() => vi.resetAllMocks());

it.each(["resize", "write", "sync"] as const)(
  "keeps native %s failures as Errors with the original OS reason and byte range",
  async (operation) => {
    const reason =
      "There is not enough space on the disk. (os error 112)";
    const path = "cublasLt64_12.dll.part";
    const size = 643 * 1024 * 1024;
    vi.mocked(invoke).mockImplementation(
      async (command) => {
        if (command === "vfs_volumes")
          return [
            {
              id: "native-default",
              name: "Disk",
              kind: "native",
            },
          ];
        if (command === `vfs_${operation}`) throw reason;
      },
    );
    const [volume] = await nativeFileSystem.volumes();
    const error = await volume
      .commit(
        path,
        [
          {
            offset: size - 64,
            data: new Uint8Array(64),
          },
        ],
        size,
      )
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(LocalFileSystemError);
    expect(error).toMatchObject({
      operation,
      path,
      cause: reason,
    });
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toContain(reason);
    if (operation === "resize") {
      expect(error).toMatchObject({ range: { size } });
      expect(invoke).not.toHaveBeenCalledWith(
        "vfs_write",
        expect.anything(),
        expect.anything(),
      );
    } else if (operation === "write") {
      expect(error).toMatchObject({
        range: { offset: size - 64, length: 64 },
      });
    }
    expect(vi.mocked(invoke).mock.calls.at(-1)?.[0]).toBe(
      `vfs_${operation}`,
    );
  },
);

it("retains read failures and their exact offset instead of losing native string rejections", async () => {
  const reason = "Access is denied. (os error 5)";
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "vfs_volumes")
      return [
        {
          id: "native-default",
          name: "Disk",
          kind: "native",
        },
      ];
    if (command === "vfs_read") throw reason;
  });
  const [volume] = await nativeFileSystem.volumes();
  await expect(
    volume.read(
      "cublasLt64_12.dll.part",
      643 * 1024 * 1024,
      64,
    ),
  ).rejects.toMatchObject({
    name: "LocalFileSystemError",
    operation: "read",
    cause: reason,
    range: { offset: 643 * 1024 * 1024, length: 64 },
  });
});

it("reveals the physical file path within its registered mount, including partial files", async () => {
  await nativeFileSystem.revealFile!(
    "native-default",
    "资料/report.pdf.part",
  );
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("vfs_reveal_file", {
    mountId: "native-default",
    path: "资料/report.pdf.part",
  });
});

it("moves a verified partial within its mount without requesting an overwrite", async () => {
  vi.mocked(invoke).mockImplementation(async (command) =>
    command === "vfs_volumes"
      ? [
          {
            id: "native-default",
            name: "Disk",
            kind: "native",
          },
        ]
      : null,
  );
  const [volume] = await nativeFileSystem.volumes();
  expect(
    await volume.move!(
      "file.bin.part",
      "file.bin",
      "verified",
    ),
  ).toBeNull();
  expect(invoke).toHaveBeenLastCalledWith("vfs_move", {
    mountId: "native-default",
    path: "file.bin.part",
    destination: "file.bin",
    revision: "verified",
  });
});

it("opens only the selected mounted root through the native directory command", async () => {
  await nativeFileSystem.openDirectory("native-default");
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith(
    "vfs_open_directory",
    {
      mountId: "native-default",
    },
  );
});

it("uses scoped binary writes with bounded messages and Unicode-safe paths", async () => {
  const writes: { offset: number; data: Uint8Array }[] = [];
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(
    async (command, args, options) => {
      commands.push(command);
      if (command === "vfs_volumes")
        return [
          {
            id: "native-default",
            name: "Disk",
            kind: "native",
          },
        ];
      if (command === "vfs_write") {
        const headers = options?.headers as Record<
          string,
          string
        >;
        expect(headers["x-vfs-path"]).toMatch(
          /^[\x20-\x7e]+$/,
        );
        expect(JSON.parse(headers["x-vfs-path"])).toBe(
          "资料/文件😀.bin",
        );
        const data = args as Uint8Array;
        expect(data.byteLength).toBeLessThanOrEqual(
          1024 * 1024,
        );
        writes.push({
          offset: Number(headers["x-vfs-offset"]),
          data,
        });
      }
      if (command === "vfs_sync")
        return {
          kind: "file",
          size: 2_500_000,
          revision: "after",
          modified: 0,
        };
    },
  );
  const [volume] = await nativeFileSystem.volumes();
  const bytes = new Uint8Array(2_500_000).fill(42);
  await volume.commit(
    "资料/文件😀.bin",
    [{ offset: 0, data: bytes }],
    bytes.length,
  );
  expect(writes.map((write) => write.offset)).toEqual([
    0, 1_048_576, 2_097_152,
  ]);
  expect(
    Buffer.concat(writes.map((write) => write.data)),
  ).toEqual(Buffer.from(bytes));
  expect(commands.at(-1)).toBe("vfs_sync");
});

it("exports a native file through range reads without materializing the entire file", async () => {
  const reads: number[] = [];
  vi.mocked(invoke).mockImplementation(
    async (command, args) => {
      const value = args as Record<string, unknown>;
      if (command === "vfs_volumes")
        return [
          {
            id: "native-default",
            name: "Disk",
            kind: "native",
          },
        ];
      if (command === "vfs_stat")
        return {
          kind: "file",
          size: 3_000_000,
          revision: "r1",
          modified: 0,
        };
      if (command === "vfs_media") {
        expect(value.revision).toBe("r1");
        return "opaque-token";
      }
      if (command === "vfs_read") {
        expect(value.revision).toBe("r1");
        reads.push(value.length as number);
        return new ArrayBuffer(value.length as number);
      }
      if (command === "file_save_begin") return "save";
    },
  );
  const [volume] = await nativeFileSystem.volumes();
  const file = await volume.file("movie.mp4", {
    name: "movie.mp4",
    type: "video/mp4",
    lastModified: 1,
  });
  expect(reads).toEqual([]);
  expect(file.url).toContain("opaque-token");
  await saveNativeFile(file, file.name);
  expect(
    reads.reduce((sum, length) => sum + length, 0),
  ).toBe(file.size);
  expect(Math.max(...reads)).toBeLessThanOrEqual(
    1024 * 1024,
  );
});
