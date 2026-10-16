// @vitest-environment node
import {
  RangeFile,
  type FileConflictResolver,
  type FileSaveProgress,
} from "@weblink/platform";
import { File as NodeFile } from "node:buffer";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { exportDirectoryFiles } from "@/libs/infrastructure/vfs/directory-export";

const keepBoth: FileConflictResolver = async () =>
  "keep_both";

beforeEach(() => vi.stubGlobal("File", NodeFile));
afterEach(() => vi.unstubAllGlobals());

function destination() {
  const entries = new Map<string, File | null>();
  const writes = vi.fn();
  const commits = vi.fn();
  const abort = vi.fn(async () => {});
  const queryPermission = vi.fn(async () => "granted");
  const getFileHandle = vi.fn(
    async (
      name: string,
      options?: { create?: boolean },
    ) => {
      if (/\.(dll|lnk)$/i.test(name))
        throw new TypeError("Name is not allowed.");
      if (entries.has(name) && entries.get(name) === null)
        throw new DOMException(
          "Directory",
          "TypeMismatchError",
        );
      if (!entries.has(name)) {
        if (!options?.create)
          throw new DOMException(
            "Missing",
            "NotFoundError",
          );
        entries.set(name, new File([], name));
      }
      return {
        getFile: async () => entries.get(name),
        createWritable: async () => {
          const chunks: BlobPart[] = [];
          return {
            truncate: async () => {},
            write: async (data: BlobPart) => {
              await writes(name, data);
              chunks.push(data);
            },
            close: async () => {
              await commits(name);
              entries.set(name, new File(chunks, name));
            },
            abort,
          };
        },
      };
    },
  );
  const removeEntry = vi.fn(async (name: string) => {
    entries.delete(name);
  });
  const directory = {
    name: "Exports",
    queryPermission,
    getFileHandle,
    getDirectoryHandle: async (name: string) => {
      if (!entries.has(name) || entries.get(name) !== null)
        throw new DOMException("Missing", "NotFoundError");
      return { name };
    },
    removeEntry,
  } as unknown as FileSystemDirectoryHandle;
  return {
    directory,
    entries,
    getFileHandle,
    removeEntry,
    queryPermission,
    writes,
    commits,
    abort,
  };
}

it("exports every file directly into the chosen directory while preserving existing files and directories", async () => {
  const f = destination();
  f.entries.set(
    "report.txt",
    new File(["original"], "report.txt"),
  );
  f.entries.set("report (1).txt", null);
  await exportDirectoryFiles(
    f.directory,
    [
      new File(["first"], "report.txt"),
      new File(["second"], "report.txt"),
      new File([], "empty.txt"),
    ],
    keepBoth,
  );
  expect(await f.entries.get("report.txt")!.text()).toBe(
    "original",
  );
  expect(f.entries.get("report (1).txt")).toBeNull();
  expect(
    await f.entries.get("report (2).txt")!.text(),
  ).toBe("first");
  expect(
    await f.entries.get("report (3).txt")!.text(),
  ).toBe("second");
  expect(f.entries.get("empty.txt")!.size).toBe(0);
  expect(f.entries.size).toBe(5);
  expect(f.removeEntry).not.toHaveBeenCalled();
});

it("applies the browser filename suffix and collision policy without changing source filenames", async () => {
  const f = destination();
  f.entries.set(
    "plugin.dll.weblink",
    new File(["original"], "plugin.dll.weblink"),
  );
  const files = [
    new File(["library"], "plugin.dll"),
    new File(["shortcut"], "shortcut.lnk"),
    new File(["literal"], "notes.weblink"),
  ];
  await exportDirectoryFiles(f.directory, files, keepBoth);
  expect(
    await f.entries.get("plugin.dll.weblink")!.text(),
  ).toBe("original");
  expect(
    await f.entries.get("plugin (1).dll.weblink")!.text(),
  ).toBe("library");
  expect(
    await f.entries.get("shortcut.lnk.weblink")!.text(),
  ).toBe("shortcut");
  expect(
    await f.entries.get("notes.weblink.weblink")!.text(),
  ).toBe("literal");
  expect(files.map((file) => file.name)).toEqual([
    "plugin.dll",
    "shortcut.lnk",
    "notes.weblink",
  ]);
});

it.each(["write", "commit"] as const)(
  "removes a failed %s export, preserves completed files, and does not retry under a suffix",
  async (stage) => {
    const f = destination();
    const failure = new TypeError("Name is not allowed.");
    (stage === "write"
      ? f.writes
      : f.commits
    ).mockImplementation((name: string) => {
      if (name === "bad.exe") throw failure;
    });
    await expect(
      exportDirectoryFiles(
        f.directory,
        [
          new File(["good"], "good.txt"),
          new File(["bad"], "bad.exe"),
          new File(["later"], "later.txt"),
        ],
        keepBoth,
      ),
    ).rejects.toMatchObject({
      fileName: "bad.exe",
      stage,
      cause: failure,
    });
    expect([...f.entries.keys()]).toEqual(["good.txt"]);
    expect(await f.entries.get("good.txt")!.text()).toBe(
      "good",
    );
    expect(f.removeEntry).toHaveBeenCalledOnce();
    expect(f.removeEntry).toHaveBeenCalledWith("bad.exe");
    expect(f.abort).toHaveBeenCalledOnce();
    expect(
      f.getFileHandle.mock.calls.some(([name]) =>
        name.endsWith(".weblink"),
      ),
    ).toBe(false);
  },
);

it("does not create or delete files if directory permission is unavailable", async () => {
  const f = destination();
  f.queryPermission.mockResolvedValue("denied");
  await expect(
    exportDirectoryFiles(
      f.directory,
      [new File(["data"], "file.txt")],
      keepBoth,
    ),
  ).rejects.toMatchObject({
    stage: "create",
    cause: { name: "StorageUnavailableError" },
  });
  expect(f.getFileHandle).not.toHaveBeenCalled();
  expect(f.removeEntry).not.toHaveBeenCalled();
});

it.each(["overwrite", "skip", "keep_both"] as const)(
  "waits for the %s choice before touching the conflicting file and continues the batch",
  async (action) => {
    const f = destination();
    f.entries.set(
      "report.txt",
      new File(["original"], "report.txt"),
    );
    const file = new File(["replacement"], "report.txt");
    const read = vi.spyOn(file, "slice");
    let choose!: (choice: typeof action) => void;
    const resolve = vi.fn<FileConflictResolver>(
      () =>
        new Promise((accept) => {
          choose = accept;
        }),
    );
    const saving = exportDirectoryFiles(
      f.directory,
      [file, new File(["next"], "next.txt")],
      resolve,
    );
    await vi.waitFor(() =>
      expect(resolve).toHaveBeenCalledOnce(),
    );
    expect(resolve).toHaveBeenCalledWith({
      fileName: "report.txt",
      canOverwrite: true,
    });
    expect(read).not.toHaveBeenCalled();
    expect(f.writes).not.toHaveBeenCalled();
    choose(action);
    expect(await saving).toBe(true);
    expect(await f.entries.get("report.txt")!.text()).toBe(
      action === "overwrite" ? "replacement" : "original",
    );
    expect(f.entries.has("report (1).txt")).toBe(
      action === "keep_both",
    );
    if (action === "keep_both")
      expect(
        await f.entries.get("report (1).txt")!.text(),
      ).toBe("replacement");
    if (action === "skip")
      expect(read).not.toHaveBeenCalled();
    expect(await f.entries.get("next.txt")!.text()).toBe(
      "next",
    );
  },
);

it("cancels the rest of a batch at a conflict without modifying existing files", async () => {
  const f = destination();
  f.entries.set(
    "report.txt",
    new File(["original"], "report.txt"),
  );
  const resolve = vi
    .fn<FileConflictResolver>()
    .mockResolvedValue(null);
  expect(
    await exportDirectoryFiles(
      f.directory,
      [
        new File(["done"], "first.txt"),
        new File(["replacement"], "report.txt"),
        new File(["later"], "later.txt"),
      ],
      resolve,
    ),
  ).toBe(false);
  expect([...f.entries.keys()]).toEqual([
    "report.txt",
    "first.txt",
  ]);
  expect(await f.entries.get("report.txt")!.text()).toBe(
    "original",
  );
  expect(f.removeEntry).not.toHaveBeenCalled();
});

it.each(["write", "commit"] as const)(
  "preserves the original file after an overwrite %s failure",
  async (stage) => {
    const f = destination();
    f.entries.set(
      "report.txt",
      new File(["original"], "report.txt"),
    );
    const failure = new DOMException(
      "Disk write failed",
      "AbortError",
    );
    (stage === "write"
      ? f.writes
      : f.commits
    ).mockImplementation(() => {
      throw failure;
    });
    await expect(
      exportDirectoryFiles(
        f.directory,
        [new File(["replacement"], "report.txt")],
        async () => "overwrite",
      ),
    ).rejects.toMatchObject({ stage, cause: failure });
    expect(await f.entries.get("report.txt")!.text()).toBe(
      "original",
    );
    expect(f.removeEntry).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalledOnce();
  },
);

it("reports same-name directories and rejects an invalid overwrite decision", async () => {
  const f = destination();
  f.entries.set("folder", null);
  const resolve = vi
    .fn<FileConflictResolver>()
    .mockResolvedValue("overwrite");
  await expect(
    exportDirectoryFiles(
      f.directory,
      [new File(["file"], "folder")],
      resolve,
    ),
  ).rejects.toThrow();
  expect(resolve).toHaveBeenCalledWith({
    fileName: "folder",
    canOverwrite: false,
  });
  expect(f.entries.get("folder")).toBeNull();
  expect(f.writes).not.toHaveBeenCalled();
  expect(f.removeEntry).not.toHaveBeenCalled();
});

it("reports bounded write progress separately from committed and skipped files, including empty files", async () => {
  const f = destination();
  const file = new File(
    [new Uint8Array(4 * 1024 * 1024 + 3)],
    "large.bin",
  );
  f.entries.set("skip.txt", new File(["old"], "skip.txt"));
  let write!: () => void;
  let commit!: () => void;
  f.writes.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        write = resolve;
      }),
  );
  f.commits.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        commit = resolve;
      }),
  );
  const progress =
    vi.fn<(value: FileSaveProgress) => void>();
  const saving = exportDirectoryFiles(
    f.directory,
    [
      file,
      new File(["skip"], "skip.txt"),
      new File([], "empty.txt"),
    ],
    async () => "skip",
    { onProgress: progress },
  );
  await vi.waitFor(() =>
    expect(f.writes).toHaveBeenCalledOnce(),
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
    expect(f.commits).toHaveBeenCalledOnce(),
  );
  expect(progress).toHaveBeenCalledWith(
    expect.objectContaining({
      fileBytesWritten: 4 * 1024 * 1024,
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
  expect(f.entries.get("large.bin")!.size).toBe(0);
  commit();
  expect(await saving).toBe(true);
  expect(progress).toHaveBeenLastCalledWith(
    expect.objectContaining({
      fileName: "empty.txt",
      fileIndex: 3,
      fileBytesWritten: 0,
      fileSize: 0,
      savedFiles: 2,
      skippedFiles: 1,
      processedBytes: file.size + 4,
      totalBytes: file.size + 4,
    }),
  );
  expect(await f.entries.get("skip.txt")!.text()).toBe(
    "old",
  );
});

it.each([false, true])(
  "cancels an in-flight write, preserves earlier files and the original, and stops later files (overwrite=%s)",
  async (overwrite) => {
    const f = destination();
    const controller = new AbortController();
    if (overwrite)
      f.entries.set(
        "large.bin",
        new File(["original"], "large.bin"),
      );
    const file = new File(
      [new Uint8Array(4 * 1024 * 1024 + 1)],
      "large.bin",
    );
    const read = vi.spyOn(file, "slice");
    const later = new File(["later"], "later.txt");
    const laterRead = vi.spyOn(later, "slice");
    let write!: () => void;
    f.writes.mockImplementation((name: string) =>
      name === file.name
        ? new Promise<void>((resolve) => {
            write = resolve;
          })
        : undefined,
    );
    const progress =
      vi.fn<(value: FileSaveProgress) => void>();
    const saving = exportDirectoryFiles(
      f.directory,
      [new File(["done"], "first.txt"), file, later],
      async () => "overwrite",
      { signal: controller.signal, onProgress: progress },
    );
    await vi.waitFor(() =>
      expect(write).toBeTypeOf("function"),
    );
    controller.abort();
    write();
    expect(await saving).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    expect(laterRead).not.toHaveBeenCalled();
    expect(f.abort).toHaveBeenCalledOnce();
    expect(f.commits).toHaveBeenCalledOnce();
    expect(await f.entries.get("first.txt")!.text()).toBe(
      "done",
    );
    if (overwrite)
      expect(await f.entries.get("large.bin")!.text()).toBe(
        "original",
      );
    else expect(f.entries.has("large.bin")).toBe(false);
    expect(f.entries.has("later.txt")).toBe(false);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        savedFiles: 1,
        skippedFiles: 0,
        fileBytesWritten: 0,
        processedBytes: 4,
      }),
    );
  },
);

it("cancels a pending source read before writing and cleans up a new destination", async () => {
  const f = destination();
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
  const saving = exportDirectoryFiles(
    f.directory,
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
  expect(f.writes).not.toHaveBeenCalled();
  expect(f.entries.size).toBe(0);
  expect(f.abort).toHaveBeenCalledOnce();
});

it("cancels even when a conflict resolver is pending and ignores its later answer", async () => {
  const f = destination();
  const controller = new AbortController();
  f.entries.set(
    "report.txt",
    new File(["original"], "report.txt"),
  );
  let answer!: (value: "overwrite") => void;
  const resolve = vi.fn<FileConflictResolver>(
    () =>
      new Promise((accept) => {
        answer = accept;
      }),
  );
  const saving = exportDirectoryFiles(
    f.directory,
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
  expect(f.writes).not.toHaveBeenCalled();
  expect(await f.entries.get("report.txt")!.text()).toBe(
    "original",
  );
});

it.each([false, true])(
  "accounts for a commit already in flight when cancelled (remaining=%s)",
  async (remaining) => {
    const f = destination();
    const controller = new AbortController();
    f.commits.mockImplementationOnce(() => {
      controller.abort();
    });
    const files = [new File(["done"], "first.txt")];
    if (remaining)
      files.push(new File(["later"], "later.txt"));
    const progress =
      vi.fn<(value: FileSaveProgress) => void>();
    expect(
      await exportDirectoryFiles(
        f.directory,
        files,
        keepBoth,
        { signal: controller.signal, onProgress: progress },
      ),
    ).toBe(!remaining);
    expect(await f.entries.get("first.txt")!.text()).toBe(
      "done",
    );
    expect(f.entries.has("later.txt")).toBe(false);
    expect(progress).toHaveBeenLastCalledWith(
      expect.objectContaining({
        savedFiles: 1,
        processedBytes: 4,
      }),
    );
    expect(f.abort).not.toHaveBeenCalled();
  },
);

it("does not touch the directory for an already cancelled batch", async () => {
  const f = destination();
  const controller = new AbortController();
  controller.abort();
  expect(
    await exportDirectoryFiles(
      f.directory,
      [new File(["data"], "report.txt")],
      keepBoth,
      { signal: controller.signal },
    ),
  ).toBe(false);
  expect(f.queryPermission).not.toHaveBeenCalled();
  expect(f.getFileHandle).not.toHaveBeenCalled();
});
