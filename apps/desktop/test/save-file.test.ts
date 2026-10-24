// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  RangeFile,
  type FileConflictResolver,
  type FileSaveProgress,
} from "@weblink/platform";
import { invoke } from "@tauri-apps/api/core";
import {
  saveNativeFile,
  saveNativeFilesToDirectory,
} from "../src/save-file";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
const keepBoth: FileConflictResolver = async () =>
  "keep_both";
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
  expect(
    Buffer.concat(chunks).equals(Buffer.from(bytes)),
  ).toBe(true);
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

it("picks one directory for more than eight files, writes sequentially, and releases the directory", async () => {
  const files = Array.from(
    { length: 12 },
    (_, index) =>
      new File([String(index)], `file-${index}.txt`),
  );
  const saved = new Map<string, string>();
  let active: string | undefined;
  vi.mocked(invoke).mockImplementation(
    async (command, args) => {
      if (command === "file_save_directory_pick")
        return "directory-id";
      if (command === "file_save_directory_begin") {
        expect(active).toBeUndefined();
        const request = args as {
          name: string;
          size: number;
          directoryId: string;
          automatic: boolean;
        };
        expect(request.directoryId).toBe("directory-id");
        active = request.name;
        return { status: "ready", id: active };
      }
      if (command === "file_save_write") {
        saved.set(
          active!,
          new TextDecoder().decode(args as ArrayBuffer),
        );
        return;
      }
      if (command === "file_save_finish") {
        expect(args).toEqual({ id: active });
        active = undefined;
        return;
      }
      expect(command).toBe("file_save_directory_release");
      expect(args).toEqual({ id: "directory-id" });
    },
  );
  expect(
    await saveNativeFilesToDirectory(files, keepBoth),
  ).toBe(true);
  expect(saved).toEqual(
    new Map(
      files.map((file, index) => [
        file.name,
        String(index),
      ]),
    ),
  );
  expect(
    vi
      .mocked(invoke)
      .mock.calls.filter(
        ([command]) =>
          command === "file_save_directory_pick",
      ),
  ).toHaveLength(1);
  expect(invoke).toHaveBeenLastCalledWith(
    "file_save_directory_release",
    { id: "directory-id" },
  );
});

it("does not read files after directory cancellation or open a picker for an empty batch", async () => {
  const file = new File(["data"], "report.txt");
  const read = vi.spyOn(file, "slice");
  vi.mocked(invoke).mockResolvedValue(null);
  expect(
    await saveNativeFilesToDirectory([], keepBoth),
  ).toBe(true);
  expect(invoke).not.toHaveBeenCalled();
  expect(
    await saveNativeFilesToDirectory([file], keepBoth),
  ).toBe(false);
  expect(invoke).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith(
    "file_save_directory_pick",
  );
  expect(read).not.toHaveBeenCalled();
});

it("aborts a failed batch file and releases its directory before allowing the next save", async () => {
  const commands: string[] = [];
  vi.mocked(invoke).mockImplementation(async (command) => {
    commands.push(command);
    if (command === "file_save_directory_pick")
      return "directory-id";
    if (command === "file_save_directory_begin")
      return { status: "ready", id: "save-id" };
    if (command === "file_save_begin") return "save-id";
    if (command === "file_save_write")
      throw new Error("Disk full");
  });
  const batch = saveNativeFilesToDirectory(
    [
      new File(["data"], "first.txt"),
      new File([], "second.txt"),
    ],
    keepBoth,
  );
  const next = saveNativeFile(new Blob([]), "next.txt");
  await expect(batch).rejects.toThrow("Disk full");
  expect(await next).toBe(true);
  expect(commands).toEqual([
    "file_save_directory_pick",
    "file_save_directory_begin",
    "file_save_write",
    "file_save_abort",
    "file_save_directory_release",
    "file_save_begin",
    "file_save_finish",
  ]);
});

it.each(["overwrite", "skip", "keep_both"] as const)(
  "resolves a native %s conflict before reading the source and continues to the next file",
  async (action) => {
    const file = new File(["replacement"], "report.txt");
    const read = vi.spyOn(file, "slice");
    let choose!: (choice: typeof action) => void;
    const resolve = vi.fn<FileConflictResolver>(
      () =>
        new Promise((accept) => {
          choose = accept;
        }),
    );
    vi.mocked(invoke).mockImplementation(
      async (command, args) => {
        if (command === "file_save_directory_pick")
          return "directory-id";
        if (command === "file_save_directory_begin") {
          const request = args as {
            name: string;
            action?: string;
          };
          if (
            request.name === "report.txt" &&
            !request.action
          )
            return {
              status: "conflict",
              fileName: "report.txt",
              canOverwrite: true,
            };
          return { status: "ready", id: request.name };
        }
      },
    );
    const saving = saveNativeFilesToDirectory(
      [file, new File([], "next.txt")],
      resolve,
    );
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledOnce(),
    );
    expect(read).not.toHaveBeenCalled();
    expect(resolve).toHaveBeenCalledWith({
      fileName: "report.txt",
      canOverwrite: true,
    });
    choose(action);
    expect(await saving).toBe(true);
    if (action === "skip")
      expect(read).not.toHaveBeenCalled();
    else {
      expect(invoke).toHaveBeenCalledWith(
        "file_save_directory_begin",
        {
          directoryId: "directory-id",
          name: "report.txt",
          size: file.size,
          action,
        },
      );
      expect(read).toHaveBeenCalled();
    }
    expect(invoke).toHaveBeenCalledWith(
      "file_save_finish",
      { id: "next.txt" },
    );
    expect(invoke).toHaveBeenLastCalledWith(
      "file_save_directory_release",
      { id: "directory-id" },
    );
  },
);

it("cancels at a native conflict and releases the export directory without starting another file", async () => {
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "file_save_directory_pick")
      return "directory-id";
    if (command === "file_save_directory_begin")
      return {
        status: "conflict",
        fileName: "report.txt",
        canOverwrite: true,
      };
  });
  expect(
    await saveNativeFilesToDirectory(
      [
        new File(["data"], "report.txt"),
        new File([], "later.txt"),
      ],
      async () => null,
    ),
  ).toBe(false);
  expect(
    vi
      .mocked(invoke)
      .mock.calls.map(([command]) => command),
  ).toEqual([
    "file_save_directory_pick",
    "file_save_directory_begin",
    "file_save_directory_release",
  ]);
});

it("asks again when the destination became a directory while the overwrite prompt was open", async () => {
  const resolve = vi
    .fn<FileConflictResolver>()
    .mockResolvedValueOnce("overwrite")
    .mockResolvedValueOnce("skip");
  vi.mocked(invoke).mockImplementation(
    async (command, args) => {
      if (command === "file_save_directory_pick")
        return "directory-id";
      if (command === "file_save_directory_begin")
        return {
          status: "conflict",
          fileName: "report.txt",
          canOverwrite: !(args as { action?: string })
            .action,
        };
    },
  );
  expect(
    await saveNativeFilesToDirectory(
      [new File(["data"], "report.txt")],
      resolve,
    ),
  ).toBe(true);
  expect(resolve).toHaveBeenNthCalledWith(2, {
    fileName: "report.txt",
    canOverwrite: false,
  });
  expect(
    vi
      .mocked(invoke)
      .mock.calls.some(
        ([command]) => command === "file_save_write",
      ),
  ).toBe(false);
});

it("reports native writes only after IPC completes, and counts files only after commit", async () => {
  const file = new File(
    [new Uint8Array(1024 * 1024 + 3)],
    "large.bin",
  );
  let write!: () => void;
  let commit!: () => void;
  let writes = 0;
  vi.mocked(invoke).mockImplementation(
    async (command, args) => {
      if (command === "file_save_directory_pick")
        return "directory-id";
      if (command === "file_save_directory_begin") {
        const { name } = args as { name: string };
        if (name === "skip.txt")
          return {
            status: "conflict",
            fileName: name,
            canOverwrite: true,
          };
        return { status: "ready", id: name };
      }
      if (command === "file_save_write" && ++writes === 1)
        return new Promise<void>((resolve) => {
          write = resolve;
        });
      if (
        command === "file_save_finish" &&
        (args as { id: string }).id === file.name
      )
        return new Promise<void>((resolve) => {
          commit = resolve;
        });
    },
  );
  const progress =
    vi.fn<(value: FileSaveProgress) => void>();
  const saving = saveNativeFilesToDirectory(
    [
      file,
      new File(["skip"], "skip.txt"),
      new File([], "empty.txt"),
    ],
    async () => "skip",
    { onProgress: progress },
  );
  await vi.waitFor(() =>
    expect(write).toBeTypeOf("function"),
  );
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fileName: "large.bin",
      fileIndex: 1,
      totalFiles: 3,
      fileBytesWritten: 0,
      savedFiles: 0,
    }),
  );
  write();
  await vi.waitFor(() =>
    expect(commit).toBeTypeOf("function"),
  );
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      fileBytesWritten: 1024 * 1024,
      savedFiles: 0,
    }),
  );
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fileBytesWritten: file.size,
      processedBytes: file.size,
      savedFiles: 0,
    }),
  );
  commit();
  expect(await saving).toBe(true);
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fileName: "empty.txt",
      fileIndex: 3,
      fileBytesWritten: 0,
      savedFiles: 2,
      skippedFiles: 1,
      processedBytes: file.size + 4,
      totalBytes: file.size + 4,
    }),
  );
});

it.each([1, 1024 * 1024 + 1])(
  "cancels a pending native write before the next chunk or final commit (size=%s)",
  async (size) => {
    const controller = new AbortController();
    const file = new File(
      [new Uint8Array(size)],
      "large.bin",
    );
    const read = vi.spyOn(file, "slice");
    let write!: () => void;
    vi.mocked(invoke).mockImplementation(
      async (command, args) => {
        if (command === "file_save_directory_pick")
          return "directory-id";
        if (command === "file_save_directory_begin")
          return {
            status: "ready",
            id: (args as { name: string }).name,
          };
        if (command === "file_save_write")
          return new Promise<void>((resolve) => {
            write = resolve;
          });
        if (command === "file_save_begin")
          return "next-save";
      },
    );
    const progress =
      vi.fn<(value: FileSaveProgress) => void>();
    const saving = saveNativeFilesToDirectory(
      [
        new File([], "first.txt"),
        file,
        new File([], "later.txt"),
      ],
      keepBoth,
      { signal: controller.signal, onProgress: progress },
    );
    await vi.waitFor(() =>
      expect(write).toBeTypeOf("function"),
    );
    controller.abort();
    write();
    expect(await saving).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith(
      "file_save_finish",
      { id: "first.txt" },
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "file_save_finish",
      { id: "large.bin" },
    );
    expect(invoke).toHaveBeenCalledWith("file_save_abort", {
      id: "large.bin",
    });
    expect(invoke).not.toHaveBeenCalledWith(
      "file_save_directory_begin",
      expect.objectContaining({ name: "later.txt" }),
    );
    expect(invoke).toHaveBeenLastCalledWith(
      "file_save_directory_release",
      { id: "directory-id" },
    );
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        savedFiles: 1,
        fileBytesWritten: 0,
        processedBytes: 0,
      }),
    );
    expect(
      await saveNativeFile(new Blob([]), "next.txt"),
    ).toBe(true);
  },
);

it("cancels during a source read and aborts the allocated native save without sending bytes", async () => {
  const controller = new AbortController();
  let read!: (bytes: ArrayBuffer) => void;
  const file = new RangeFile(
    "report.txt",
    4,
    "",
    0,
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        read = resolve;
      }),
  );
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "file_save_directory_pick")
      return "directory-id";
    if (command === "file_save_directory_begin")
      return { status: "ready", id: "save-id" };
  });
  const saving = saveNativeFilesToDirectory(
    [file],
    keepBoth,
    { signal: controller.signal },
  );
  await vi.waitFor(() =>
    expect(read).toBeTypeOf("function"),
  );
  controller.abort();
  read(new ArrayBuffer(4));
  expect(await saving).toBe(false);
  expect(invoke).not.toHaveBeenCalledWith(
    "file_save_write",
    expect.anything(),
    expect.anything(),
  );
  expect(invoke).toHaveBeenCalledWith("file_save_abort", {
    id: "save-id",
  });
  expect(invoke).toHaveBeenLastCalledWith(
    "file_save_directory_release",
    { id: "directory-id" },
  );
});

it("cancels a queued batch before opening its directory picker", async () => {
  let pick!: (value: null) => void;
  vi.mocked(invoke).mockImplementation(
    () =>
      new Promise<null>((resolve) => {
        pick = resolve;
      }),
  );
  const first = saveNativeFile(new Blob([]), "first.txt");
  const controller = new AbortController();
  const batch = saveNativeFilesToDirectory(
    [new File([], "batch.txt")],
    keepBoth,
    { signal: controller.signal },
  );
  await vi.waitFor(() =>
    expect(invoke).toHaveBeenCalledOnce(),
  );
  controller.abort();
  pick(null);
  expect(await first).toBe(false);
  expect(await batch).toBe(false);
  expect(invoke).toHaveBeenCalledOnce();
});

it.each(["picker", "begin"])(
  "releases native capabilities when cancelled during %s",
  async (stage) => {
    const controller = new AbortController();
    const file = new File(["data"], "report.txt");
    const read = vi.spyOn(file, "slice");
    vi.mocked(invoke).mockImplementation(
      async (command) => {
        if (command === "file_save_directory_pick") {
          if (stage === "picker") controller.abort();
          return "directory-id";
        }
        if (command === "file_save_directory_begin") {
          controller.abort();
          return { status: "ready", id: "save-id" };
        }
      },
    );
    expect(
      await saveNativeFilesToDirectory([file], keepBoth, {
        signal: controller.signal,
      }),
    ).toBe(false);
    expect(read).not.toHaveBeenCalled();
    if (stage === "begin")
      expect(invoke).toHaveBeenCalledWith(
        "file_save_abort",
        { id: "save-id" },
      );
    expect(invoke).toHaveBeenLastCalledWith(
      "file_save_directory_release",
      { id: "directory-id" },
    );
  },
);

it("cancels a pending conflict without waiting for its answer and releases the directory", async () => {
  const controller = new AbortController();
  let answer!: (action: "overwrite") => void;
  const resolve = vi.fn<FileConflictResolver>(
    () =>
      new Promise((accept) => {
        answer = accept;
      }),
  );
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "file_save_directory_pick")
      return "directory-id";
    if (command === "file_save_directory_begin")
      return {
        status: "conflict",
        fileName: "report.txt",
        canOverwrite: true,
      };
  });
  const saving = saveNativeFilesToDirectory(
    [new File(["replacement"], "report.txt")],
    resolve,
    { signal: controller.signal },
  );
  await vi.waitFor(() =>
    expect(resolve).toHaveBeenCalledOnce(),
  );
  controller.abort();
  expect(await saving).toBe(false);
  answer("overwrite");
  await Promise.resolve();
  expect(
    vi
      .mocked(invoke)
      .mock.calls.map(([command]) => command),
  ).toEqual([
    "file_save_directory_pick",
    "file_save_directory_begin",
    "file_save_directory_release",
  ]);
});

it.each([false, true])(
  "counts a native commit that finishes after cancellation (remaining=%s)",
  async (remaining) => {
    const controller = new AbortController();
    vi.mocked(invoke).mockImplementation(
      async (command, args) => {
        if (command === "file_save_directory_pick")
          return "directory-id";
        if (command === "file_save_directory_begin")
          return {
            status: "ready",
            id: (args as { name: string }).name,
          };
        if (command === "file_save_finish")
          controller.abort();
      },
    );
    const files = [new File(["done"], "first.txt")];
    if (remaining)
      files.push(new File(["later"], "later.txt"));
    const progress =
      vi.fn<(value: FileSaveProgress) => void>();
    expect(
      await saveNativeFilesToDirectory(files, keepBoth, {
        signal: controller.signal,
        onProgress: progress,
      }),
    ).toBe(!remaining);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        savedFiles: 1,
        processedBytes: 4,
      }),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "file_save_abort",
      expect.anything(),
    );
    expect(invoke).not.toHaveBeenCalledWith(
      "file_save_directory_begin",
      expect.objectContaining({ name: "later.txt" }),
    );
  },
);
