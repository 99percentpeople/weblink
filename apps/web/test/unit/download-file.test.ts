// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { toast } from "solid-sonner";
import { platform } from "@/libs/platform/runtime";
import {
  downloadFile,
  downloadUrl,
  saveFile,
  saveFileAs,
  saveFilesAs,
} from "@/libs/utils/download-file";
import {
  RangeFile,
  type FileBatchSaveOptions,
  type FileConflictResolver,
} from "@weblink/platform";
import { exportDirectoryFiles } from "@/libs/infrastructure/vfs/directory-export";

vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    saveFile: undefined,
    saveFilesToDirectory: undefined,
  },
}));
vi.mock(
  "@/libs/infrastructure/vfs/directory-export",
  () => ({
    exportDirectoryFiles: vi.fn(),
  }),
);
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));

const resolveConflict = vi
  .fn<FileConflictResolver>()
  .mockResolvedValue("keep_both");

const createUrl = vi.fn(() => "blob:received-file");
const revokeUrl = vi.fn();

function streamedFile(name = "original.dll") {
  const data = new TextEncoder().encode(
    "original file bytes",
  );
  return new RangeFile(
    name,
    data.length,
    "application/octet-stream",
    0,
    async (offset, length) =>
      data.slice(offset, offset + length).buffer,
  );
}
beforeEach(() => {
  platform.saveFile = undefined;
  platform.saveFilesToDirectory = undefined;
  vi.mocked(exportDirectoryFiles).mockResolvedValue(true);
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: createUrl,
      revokeObjectURL: revokeUrl,
    }),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("opens the browser save-as picker before reading and streams bytes under the original name", async () => {
  const file = streamedFile();
  const stream = vi.spyOn(file, "stream");
  const chunks: Uint8Array[] = [];
  const close = vi.fn();
  const writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      chunks.push(chunk);
    },
    close,
  });
  const picker = vi.fn().mockResolvedValue({
    createWritable: async () => writable,
  });
  vi.stubGlobal("showSaveFilePicker", picker);
  const saving = saveFileAs(file);
  expect(picker).toHaveBeenCalledWith({
    suggestedName: "original.dll",
  });
  expect(stream).not.toHaveBeenCalled();
  expect(await saving).toBe(true);
  expect(new TextDecoder().decode(chunks[0])).toBe(
    "original file bytes",
  );
  expect(close).toHaveBeenCalledOnce();
  expect(createUrl).not.toHaveBeenCalled();
});

it("cancels save-as without reading or downloading the file, but reports write failures", async () => {
  const file = streamedFile();
  const stream = vi.spyOn(file, "stream");
  const picker = vi
    .fn()
    .mockRejectedValue(
      new DOMException("Cancelled", "AbortError"),
    );
  vi.stubGlobal("showSaveFilePicker", picker);
  expect(await saveFileAs(file)).toBe(false);
  expect(stream).not.toHaveBeenCalled();
  expect(createUrl).not.toHaveBeenCalled();
  const failure = new DOMException(
    "Write rejected",
    "AbortError",
  );
  picker.mockResolvedValue({
    createWritable: async () =>
      new WritableStream({
        write: () => {
          throw failure;
        },
      }),
  });
  await expect(saveFileAs(file)).rejects.toBe(failure);
});

it("uses an explicit native save dialog for save-as", async () => {
  const file = streamedFile();
  platform.saveFile = vi.fn().mockResolvedValue(false);
  expect(await saveFileAs(file)).toBe(false);
  expect(platform.saveFile).toHaveBeenCalledWith(
    file,
    file.name,
    { automatic: false },
  );
});

it("picks one directory before reading any file and exports the whole batch there", async () => {
  const files = [
    streamedFile("first.txt"),
    streamedFile("second.txt"),
  ];
  const reads = files.map((file) =>
    vi.spyOn(file, "slice"),
  );
  let select!: (handle: unknown) => void;
  const picker = vi.fn(
    () =>
      new Promise((resolve) => {
        select = resolve;
      }),
  );
  const savePicker = vi.fn();
  vi.stubGlobal("showSaveFilePicker", savePicker);
  vi.stubGlobal("showDirectoryPicker", picker);
  const saving = saveFilesAs(files, resolveConflict);
  expect(picker).toHaveBeenCalledOnce();
  expect(picker).toHaveBeenCalledWith({
    mode: "readwrite",
  });
  expect(exportDirectoryFiles).not.toHaveBeenCalled();
  for (const read of reads)
    expect(read).not.toHaveBeenCalled();
  const directory = { name: "Exports" };
  select(directory);
  expect(await saving).toBe(true);
  expect(picker).toHaveBeenCalledOnce();
  expect(savePicker).not.toHaveBeenCalled();
  expect(exportDirectoryFiles).toHaveBeenCalledWith(
    directory,
    files,
    resolveConflict,
    undefined,
  );
  expect(exportDirectoryFiles).toHaveBeenCalledOnce();
});

it.each(["cancel", "error"])(
  "does not export any files when the directory picker ends with %s",
  async (reason) => {
    const failure =
      reason === "cancel"
        ? new DOMException("Cancelled", "AbortError")
        : new DOMException(
            "Permission denied",
            "SecurityError",
          );
    const picker = vi.fn().mockRejectedValue(failure);
    vi.stubGlobal("showDirectoryPicker", picker);
    const saving = saveFilesAs(
      [
        streamedFile("first.txt"),
        streamedFile("second.txt"),
        streamedFile("third.txt"),
      ],
      resolveConflict,
    );
    if (reason === "cancel")
      expect(await saving).toBe(false);
    else await expect(saving).rejects.toBe(failure);
    expect(picker).toHaveBeenCalledOnce();
    expect(exportDirectoryFiles).not.toHaveBeenCalled();
    expect(createUrl).not.toHaveBeenCalled();
  },
);

it("routes a native batch to one directory picker rather than individual file savers", async () => {
  platform.saveFile = vi.fn();
  platform.saveFilesToDirectory = vi
    .fn()
    .mockResolvedValue(false);
  const files = [
    streamedFile("first.txt"),
    streamedFile("second.txt"),
    streamedFile("third.txt"),
  ];
  expect(await saveFilesAs(files, resolveConflict)).toBe(
    false,
  );
  expect(
    platform.saveFilesToDirectory,
  ).toHaveBeenCalledOnce();
  expect(
    platform.saveFilesToDirectory,
  ).toHaveBeenCalledWith(files, resolveConflict, undefined);
  expect(platform.saveFile).not.toHaveBeenCalled();
  expect(exportDirectoryFiles).not.toHaveBeenCalled();
});

it("does not misreport a write AbortError as directory-picker cancellation", async () => {
  const failure = new DOMException(
    "Write rejected",
    "AbortError",
  );
  vi.stubGlobal(
    "showDirectoryPicker",
    vi.fn().mockResolvedValue({ name: "Exports" }),
  );
  vi.mocked(exportDirectoryFiles).mockRejectedValueOnce(
    failure,
  );
  await expect(
    saveFilesAs([streamedFile()], resolveConflict),
  ).rejects.toBe(failure);
});

it.each([false, true])(
  "forwards progress and cancellation options to the exporter (native=%s)",
  async (native) => {
    const options: FileBatchSaveOptions = {
      signal: new AbortController().signal,
      onProgress: vi.fn(),
    };
    const files = [streamedFile()];
    const directory = { name: "Exports" };
    vi.stubGlobal(
      "showDirectoryPicker",
      vi.fn().mockResolvedValue(directory),
    );
    if (native)
      platform.saveFilesToDirectory = vi
        .fn()
        .mockResolvedValue(true);
    expect(
      await saveFilesAs(files, resolveConflict, options),
    ).toBe(true);
    if (native)
      expect(
        platform.saveFilesToDirectory,
      ).toHaveBeenCalledWith(
        files,
        resolveConflict,
        options,
      );
    else
      expect(exportDirectoryFiles).toHaveBeenCalledWith(
        directory,
        files,
        resolveConflict,
        options,
      );
  },
);

it("does not export after cancellation before or during directory selection", async () => {
  const controller = new AbortController();
  let select!: (
    directory: FileSystemDirectoryHandle,
  ) => void;
  const picker = vi.fn(
    () =>
      new Promise<FileSystemDirectoryHandle>((resolve) => {
        select = resolve;
      }),
  );
  vi.stubGlobal("showDirectoryPicker", picker);
  const options = { signal: controller.signal };
  const files = [streamedFile()];
  const saving = saveFilesAs(
    files,
    resolveConflict,
    options,
  );
  controller.abort();
  select({ name: "Exports" } as FileSystemDirectoryHandle);
  expect(await saving).toBe(false);
  expect(
    await saveFilesAs(files, resolveConflict, options),
  ).toBe(false);
  expect(picker).toHaveBeenCalledOnce();
  expect(exportDirectoryFiles).not.toHaveBeenCalled();
});

it("does not open pickers for an empty batch or fall back to individual dialogs without directory support", async () => {
  const savePicker = vi.fn();
  vi.stubGlobal("showSaveFilePicker", savePicker);
  vi.stubGlobal("showDirectoryPicker", undefined);
  expect(await saveFilesAs([], resolveConflict)).toBe(true);
  await expect(
    saveFilesAs([streamedFile()], resolveConflict),
  ).rejects.toThrow("Directory selection is unavailable");
  expect(savePicker).not.toHaveBeenCalled();
  expect(exportDirectoryFiles).not.toHaveBeenCalled();
});

it("routes received files to the desktop saver rather than a WebView blob navigation", async () => {
  const file = new File(["received"], "report.txt");
  const nativeSave = vi.fn().mockResolvedValue(true);
  platform.saveFile = nativeSave;
  await saveFile(file, file.name);
  expect(nativeSave).toHaveBeenCalledWith(
    file,
    "report.txt",
    undefined,
  );
  expect(createUrl).not.toHaveBeenCalled();
});

it("preserves automatic download intent and treats cancellation quietly", async () => {
  const file = new File(["received"], "report.txt");
  const nativeSave = vi.fn().mockResolvedValue(false);
  platform.saveFile = nativeSave;
  downloadFile(file, { automatic: true });
  await Promise.resolve();
  expect(nativeSave).toHaveBeenCalledWith(
    file,
    "report.txt",
    { automatic: true },
  );
  expect(toast.error).not.toHaveBeenCalled();
});

it("reports native save failures instead of silently doing nothing", async () => {
  platform.saveFile = vi
    .fn()
    .mockRejectedValue(new Error("Disk full"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  downloadFile(new File(["received"], "report.txt"));
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "common.notification.file_save_failed",
    ),
  );
});

it("saves gallery object URL content through the same native path", async () => {
  const blob = new Blob(["image"]);
  const fetchFile = vi.fn().mockResolvedValue({
    ok: true,
    blob: async () => blob,
  });
  const nativeSave = vi.fn().mockResolvedValue(true);
  vi.stubGlobal("fetch", fetchFile);
  platform.saveFile = nativeSave;
  downloadUrl("blob:gallery-image", "photo.png");
  await vi.waitFor(() =>
    expect(nativeSave).toHaveBeenCalledWith(
      blob,
      "photo.png",
      undefined,
    ),
  );
  expect(fetchFile).toHaveBeenCalledWith(
    "blob:gallery-image",
  );
});

it("keeps browser downloads with the original filename and releases the object URL later", async () => {
  vi.useFakeTimers();
  const click = vi
    .spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.isConnected).toBe(true);
      expect(this.download).toBe("report.txt");
      expect(this.href).toBe("blob:received-file");
    });
  await saveFile(new Blob(["received"]), "report.txt");
  expect(click).toHaveBeenCalledOnce();
  expect(document.querySelector("a[download]")).toBeNull();
  expect(revokeUrl).not.toHaveBeenCalled();
  vi.runAllTimers();
  expect(revokeUrl).toHaveBeenCalledWith(
    "blob:received-file",
  );
});
