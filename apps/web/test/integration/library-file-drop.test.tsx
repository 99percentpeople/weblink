// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { reconcile } from "solid-js/store";
import FileManager from "@/components/files/file-manager";
import { SharedFilesPanel } from "@/components/files/shared-files-panel";
import { cacheManager } from "@/libs/application/cache-service";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import {
  handleDropItems,
  handleSelectFolder,
} from "@/libs/utils/process-file";
import { toast, Toaster } from "solid-sonner";
import { fakeCache } from "../support/file-transfer";
import { deferred } from "../support/rtc-transport";
import type { FileImportResult } from "@/libs/application/file-library-service";
import { DirectoryWriteError } from "@/libs/domain/vfs";
import { copyText } from "@/libs/utils/copy-text";

vi.mock("@/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    params &&
    (key.startsWith("file_import_progress.") ||
      key.startsWith("file_import_error."))
      ? `${key}: ${JSON.stringify(params)}`
      : key,
}));
vi.mock("@/libs/utils/copy-text", () => ({
  copyText: vi.fn(),
}));
vi.mock("@/components/icons", () => ({
  IconClose: () => null,
  IconPlaceItem: () => null,
}));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {
    storage: {
      authorizeDefault: vi.fn(),
      defaultMountId: "indexeddb",
      onChange: () => () => {},
    },
    library: { importFile: vi.fn(), setShared: vi.fn() },
  },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleDropItems: vi.fn(),
  handleSelectFolder: vi.fn(),
}));
vi.mock("@/components/dialogs/preview-dialog", () => ({
  createPreviewDialog: () => ({ open: vi.fn() }),
}));
vi.mock("@/components/dialogs/forward-dialog", () => ({
  createForwardDialog: () => ({ forwardCache: vi.fn() }),
}));
vi.mock("@/components/dialogs/dialog", () => ({
  createDialog: () => ({ open: vi.fn(), submit: vi.fn() }),
}));
vi.mock("@/components/files/file-picker-dialog", () => ({
  default: () => null,
}));
vi.mock("@/components/files/file-browser", () => ({
  useLibraryFiles: () => () => [],
  FileBrowser: () => (
    <input type="search" aria-label="Files" />
  ),
}));
vi.mock("@/components/common/client-avatar", () => ({
  ClientAvatar: () => null,
}));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(
    cacheManager.storage.authorizeDefault,
  ).mockResolvedValue(undefined);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
  vi.spyOn(toast, "message");
  vi.spyOn(toast, "dismiss");
  vi.spyOn(toast, "success");
  vi.spyOn(toast, "error");
  vi.mocked(copyText).mockResolvedValue(true);
  render(() => <Toaster theme="light" />);
  vi.mocked(
    cacheManager.library.importFile,
  ).mockImplementation(async (file) => ({
    cache: fakeCache(file.name),
    reused: false,
  }));
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function shared(split = false) {
  const [member, setMember] = createSignal<
    string | undefined
  >("local");
  const view = render(() => (
    <SharedFilesPanel
      active
      split={split}
      browsing={split}
      member={member()}
      onBack={() => {}}
      onSelect={setMember}
    />
  ));
  return { ...view, setMember };
}

function cacheView() {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <Show when={open()}>
      <FileManager />
    </Show>
  ));
  return {
    close: () => setOpen(false),
    reopen: () => setOpen(true),
  };
}

function drop(files: File[], items?: unknown[]) {
  return fireEvent.drop(
    screen.getByRole("searchbox", { name: "Files" }),
    {
      dataTransfer: { types: ["Files"], files, items },
    },
  );
}
function cancelImport() {
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
}

describe("library file drop integration", () => {
  it.each([
    [
      "identifying",
      new DOMException(
        "The selected file could not be read",
        "NotReadableError",
      ),
      "NotReadableError: The selected file could not be read",
    ],
    [
      "writing",
      "Access is denied. (os error 5)",
      "Access is denied. (os error 5)",
    ],
    [
      "verifying",
      new Error("File changed while checking", {
        cause: "Native revision mismatch",
      }),
      "Native revision mismatch",
    ],
  ] as const)(
    "identifies the failed file and its %s stage after earlier files succeeded",
    async (stage, reason, detail) => {
      vi.mocked(cacheManager.library.importFile)
        .mockResolvedValueOnce({
          cache: fakeCache("good.txt"),
          reused: false,
        })
        .mockImplementationOnce(async (_file, options) => {
          options?.onImportProgress?.({
            phase: stage,
            bytes: 0,
          });
          throw reason;
        });
      render(() => <FileManager />);
      drop([
        new File(["ok"], "good.txt"),
        new File(["bad"], "unreadable.pdf"),
        new File(["next"], "next.txt"),
      ]);
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledOnce(),
      );
      const [title, options] = vi.mocked(toast.error).mock
        .calls[0];
      expect(title).toBe("file_import_error.title");
      expect(options?.description).toContain(
        "unreadable.pdf (3.00 B)",
      );
      expect(options?.description).toContain(
        `file_import_error.${stage}`,
      );
      expect(options?.description).toContain(
        '"completed":1,"total":3',
      );
      expect(options?.description).toContain(detail);
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledTimes(2);
      expect(toast.success).not.toHaveBeenCalled();
    },
  );

  it("copies the file, stage and original error while keeping the diagnostic toast visible", async () => {
    vi.mocked(
      cacheManager.library.importFile,
    ).mockRejectedValueOnce(
      new DOMException(
        "The file could not be read",
        "NotReadableError",
      ),
    );
    render(() => <FileManager />);
    drop([new File(["bad"], "unreadable.pdf")]);
    const copy = await screen.findByRole("button", {
      name: "file_import_error.copy_details",
    });
    const notice = toast
      .getToasts()
      .find((item) => item.type === "error")!;
    fireEvent.click(copy);
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledOnce(),
    );
    const copied = vi.mocked(copyText).mock.calls[0][0];
    expect(copied).toContain("unreadable.pdf");
    expect(copied).toContain(
      "file_import_error.identifying",
    );
    expect(copied).toContain(
      "NotReadableError: The file could not be read",
    );
    expect(
      toast
        .getToasts()
        .some((item) => item.id === notice.id),
    ).toBe(true);
  });

  it("distinguishes native storage authorization errors from file reads", async () => {
    vi.mocked(
      cacheManager.storage.authorizeDefault,
    ).mockRejectedValueOnce("Unknown directory capability");
    render(() => <FileManager />);
    drop([new File(["file"], "source.txt")]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledOnce(),
    );
    const description = vi.mocked(toast.error).mock
      .calls[0][1]?.description;
    expect(description).toContain(
      "file_import_error.authorizing",
    );
    expect(description).toContain(
      "Unknown directory capability",
    );
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
  });

  it("retains folder preparation errors even when permission finishes separately", async () => {
    const pending = deferred<void>();
    vi.mocked(
      cacheManager.storage.authorizeDefault,
    ).mockReturnValueOnce(pending.promise);
    vi.mocked(handleDropItems).mockRejectedValueOnce(
      new Error("Folder archive failed"),
    );
    render(() => <FileManager />);
    drop([], [{}]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledOnce(),
    );
    const description = vi.mocked(toast.error).mock
      .calls[0][1]?.description;
    expect(description).toContain(
      "file_import_error.preparing",
    );
    expect(description).toContain("Folder archive failed");
    pending.resolve();
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
  });

  it("reports an unsolicited AbortError as a failed import, not a user cancellation", async () => {
    vi.mocked(
      cacheManager.library.importFile,
    ).mockRejectedValueOnce(
      new DOMException(
        "Security check aborted this write",
        "AbortError",
      ),
    );
    render(() => <FileManager />);
    drop([new File(["file"], "source.txt")]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledOnce(),
    );
    expect(vi.mocked(toast.error).mock.calls[0][0]).toBe(
      "file_import_error.title",
    );
    expect(
      vi.mocked(toast.error).mock.calls[0][1]?.description,
    ).toContain(
      "AbortError: Security check aborted this write",
    );
  });

  it.each(["picker", "drop"])(
    "keeps a %s import and its progress alive after the cache dialog closes",
    async (source) => {
      const first = deferred<FileImportResult>();
      const second = deferred<FileImportResult>();
      vi.mocked(cacheManager.library.importFile)
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const view = cacheView();
      const files = [
        new File(["123456"], "first.txt"),
        new File(["123"], "second.txt"),
      ];
      if (source === "picker")
        fireEvent.change(
          screen.getByLabelText(
            "shared_files.upload_files",
          ),
          { target: { files } },
        );
      else drop(files);
      await waitFor(() =>
        expect(
          cacheManager.library.importFile,
        ).toHaveBeenCalledOnce(),
      );
      const options = vi.mocked(
        cacheManager.library.importFile,
      ).mock.calls[0][1]!;
      const progress = () =>
        screen.getByRole("progressbar", {
          name: "file_import_progress.title",
        });
      expect(toast.message).toHaveBeenCalledOnce();
      const notice = vi.mocked(toast.message).mock
        .calls[0][1]!;
      expect(notice).toMatchObject({
        duration: Infinity,
        dismissible: false,
        closeButton: false,
      });
      options.onImportProgress!({
        phase: "identifying",
        bytes: 3,
      });
      expect(progress()).toHaveAttribute(
        "aria-valuenow",
        "11",
      );
      view.close();
      expect(
        screen.queryByRole("searchbox"),
      ).not.toBeInTheDocument();
      expect(options.signal!.aborted).toBe(false);
      expect(toast.dismiss).not.toHaveBeenCalled();
      options.onImportProgress!({
        phase: "writing",
        bytes: 3,
      });
      expect(progress()).toHaveAttribute(
        "aria-valuenow",
        "33",
      );
      expect(
        screen.getByText("first.txt"),
      ).toBeInTheDocument();
      first.resolve({
        cache: fakeCache("first.txt"),
        reused: false,
      });
      await waitFor(() =>
        expect(
          cacheManager.library.importFile,
        ).toHaveBeenCalledTimes(2),
      );
      expect(
        screen.getByText("second.txt"),
      ).toBeInTheDocument();
      expect(progress()).toHaveAttribute(
        "aria-valuenow",
        "66",
      );
      const next = vi.mocked(
        cacheManager.library.importFile,
      ).mock.calls[1][1]!;
      next.onImportProgress!({
        phase: "verifying",
        bytes: 3,
      });
      expect(progress()).toHaveAttribute(
        "aria-valuenow",
        "99",
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(
        toast
          .getToasts()
          .filter((item) => item.id === notice.id),
      ).toHaveLength(1);
      expect(toast.message).toHaveBeenCalledOnce();
      second.resolve({
        cache: fakeCache("second.txt"),
        reused: false,
      });
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "file_library.imported",
        ),
      );
      await waitFor(() =>
        expect(
          screen.queryByRole("progressbar"),
        ).not.toBeInTheDocument(),
      );
      expect(
        cacheManager.library.setShared,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["picker", "drop"])(
    "continues %s folder preparation after closing and can cancel from its toast",
    async (source) => {
      const pending = deferred<File>();
      vi.mocked(handleSelectFolder).mockReturnValueOnce(
        pending.promise,
      );
      vi.mocked(handleDropItems).mockReturnValueOnce(
        pending.promise.then((file) => [file]),
      );
      const view = cacheView();
      if (source === "picker")
        fireEvent.change(
          screen.getByLabelText(
            "shared_files.upload_folder",
          ),
          {
            target: {
              files: [new File(["folder"], "file.txt")],
            },
          },
        );
      else drop([], [{}]);
      const signal =
        source === "picker"
          ? vi.mocked(handleSelectFolder).mock.calls[0][1]!
          : vi.mocked(handleDropItems).mock.calls[0][1]!;
      view.close();
      expect(signal.aborted).toBe(false);
      expect(
        screen.getByText("file_import_progress.preparing"),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("progressbar"),
      ).not.toHaveAttribute("aria-valuenow");
      cancelImport();
      expect(signal.aborted).toBe(true);
      pending.resolve(new File(["zip"], "folder.zip"));
      await waitFor(() =>
        expect(
          screen.queryByRole("progressbar"),
        ).not.toBeInTheDocument(),
      );
      expect(
        cacheManager.library.importFile,
      ).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("finishes directory authorization and folder preparation in the background", async () => {
    const reading = deferred<File[]>();
    const permission = deferred<void>();
    vi.mocked(handleDropItems).mockReturnValueOnce(
      reading.promise,
    );
    vi.mocked(
      cacheManager.storage.authorizeDefault,
    ).mockReturnValueOnce(permission.promise);
    const view = cacheView();
    drop([], [{}]);
    const signal =
      vi.mocked(handleDropItems).mock.calls[0][1]!;
    view.close();
    reading.resolve([new File(["zip"], "folder.zip")]);
    await reading.promise;
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
    expect(signal.aborted).toBe(false);
    permission.resolve();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "file_library.imported",
      ),
    );
    expect(
      cacheManager.library.importFile,
    ).toHaveBeenCalledOnce();
  });

  it("keeps reopened cache batches independent and cancels remaining files only in the chosen batch", async () => {
    const first = deferred<FileImportResult>();
    const second = deferred<FileImportResult>();
    vi.mocked(cacheManager.library.importFile)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const view = cacheView();
    drop([
      new File(["first"], "first.txt"),
      new File(["skip"], "skip.txt"),
    ]);
    await waitFor(() =>
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledOnce(),
    );
    const firstSignal = vi.mocked(
      cacheManager.library.importFile,
    ).mock.calls[0][1]!.signal!;
    view.close();
    view.reopen();
    drop([new File(["second"], "second.txt")]);
    await waitFor(() =>
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledTimes(2),
    );
    const secondSignal = vi.mocked(
      cacheManager.library.importFile,
    ).mock.calls[1][1]!.signal!;
    view.close();
    const notices = screen.getAllByRole("region", {
      name: "file_import_progress.title",
    });
    const firstNotice = notices.find((notice) =>
      within(notice).queryByText("first.txt"),
    )!;
    fireEvent.click(
      within(firstNotice).getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    expect(firstSignal.aborted).toBe(true);
    expect(secondSignal.aborted).toBe(false);
    first.resolve({
      cache: fakeCache("first.txt"),
      reused: false,
    });
    second.resolve({
      cache: fakeCache("second.txt"),
      reused: false,
    });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledOnce(),
    );
    expect(
      cacheManager.library.importFile,
    ).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("reports a failed background save with the original browser details", async () => {
    const pending = deferred<FileImportResult>();
    vi.mocked(
      cacheManager.library.importFile,
    ).mockReturnValueOnce(pending.promise);
    const view = cacheView();
    drop([new File(["MZ"], "program.exe")]);
    await waitFor(() =>
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledOnce(),
    );
    view.close();
    pending.reject(
      new DirectoryWriteError(
        "program.exe",
        "commit",
        new DOMException(
          "Browser security check failed",
          "AbortError",
        ),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText(
          /AbortError: Browser security check failed/,
        ),
      ).toBeInTheDocument(),
    );
    expect(toast.success).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("progressbar"),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows the file operation and original browser error for a rejected final save", async () => {
    render(() => <FileManager />);
    vi.mocked(
      cacheManager.library.importFile,
    ).mockRejectedValueOnce(
      new DirectoryWriteError(
        "program.exe",
        "commit",
        new DOMException(
          "The file was blocked by a security check.",
          "AbortError",
        ),
      ),
    );
    drop([new File(["MZ"], "program.exe")]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "storage.write_failed",
        expect.objectContaining({
          description: expect.stringContaining(
            "AbortError: The file was blocked by a security check.",
          ),
        }),
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });
  it("requests directory access while the drop is active and waits before importing", async () => {
    render(() => <FileManager />);
    const reading = deferred<File[]>();
    const permission = deferred<void>();
    vi.mocked(handleDropItems).mockReturnValueOnce(
      reading.promise,
    );
    vi.mocked(
      cacheManager.storage.authorizeDefault,
    ).mockReturnValueOnce(permission.promise);
    drop([], [{}]);
    expect(handleDropItems).toHaveBeenCalledOnce();
    expect(
      cacheManager.storage.authorizeDefault,
    ).toHaveBeenCalledOnce();
    reading.resolve([new File(["data"], "file.txt")]);
    await reading.promise;
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
    permission.resolve();
    await waitFor(() =>
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledOnce(),
    );
  });

  it("stops the upload and cancels dropped-file reading when directory access is denied", async () => {
    render(() => <FileManager />);
    const reading = deferred<File[]>();
    vi.mocked(handleDropItems).mockReturnValueOnce(
      reading.promise,
    );
    vi.mocked(
      cacheManager.storage.authorizeDefault,
    ).mockRejectedValueOnce(
      new Error("Directory access was not granted"),
    );
    drop([], [{}]);
    const signal =
      vi.mocked(handleDropItems).mock.calls[0][1]!;
    await waitFor(() => expect(signal.aborted).toBe(true));
    reading.resolve([new File(["data"], "file.txt")]);
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it.each([
    { split: false, target: "heading" },
    { split: true, target: "heading" },
    { split: false, target: "button" },
    { split: true, target: "button" },
  ])(
    "accepts files over the header $target (split=$split)",
    async ({ split, target }) => {
      shared(split);
      const element = screen.getByRole(target, {
        name:
          target === "heading"
            ? "shared_files.mine"
            : "shared_files.add",
      });
      const file = new File(["header"], "header.txt");
      const dataTransfer = {
        types: ["Files"],
        files: [file],
      };
      expect(
        fireEvent.dragEnter(element, { dataTransfer }),
      ).toBe(false);
      expect(
        screen.getByText("shared_files.drop_files"),
      ).toBeInTheDocument();
      expect(
        fireEvent.drop(element, { dataTransfer }),
      ).toBe(false);
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "shared_files.added",
        ),
      );
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledOnce();
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledWith(file, {
        signal: expect.any(AbortSignal),
        silent: true,
        onImportProgress: expect.any(Function),
      });
      expect(
        cacheManager.library.setShared,
      ).toHaveBeenCalledOnce();
      expect(
        cacheManager.library.setShared,
      ).toHaveBeenCalledWith("header.txt", true);
    },
  );

  it.each([undefined, []])(
    "imports plain file drops into the cache without sharing (items=%s)",
    async (items) => {
      render(() => <FileManager />);
      const files = [
        new File(["a"], "a.txt"),
        new File(["b"], "b.txt"),
      ];
      expect(drop(files, items)).toBe(false);
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "file_library.imported",
        ),
      );
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledTimes(2);
      for (const file of files)
        expect(
          cacheManager.library.importFile,
        ).toHaveBeenCalledWith(file, {
          signal: expect.any(AbortSignal),
          silent: true,
          onImportProgress: expect.any(Function),
        });
      expect(
        cacheManager.library.setShared,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "imports dropped folders through the archive reader and shares only after import (split=%s)",
    async (split) => {
      shared(split);
      const zip = new File(["zip"], "folder.zip");
      const file = new File(["plain"], "plain.txt");
      const items = [{}];
      vi.mocked(handleDropItems).mockResolvedValueOnce([
        file,
        zip,
      ]);
      const order: string[] = [];
      vi.mocked(
        cacheManager.library.importFile,
      ).mockImplementation(async (file) => {
        order.push(`import:${file.name}`);
        return {
          cache: fakeCache(file.name),
          reused: false,
        };
      });
      vi.mocked(
        cacheManager.library.setShared,
      ).mockImplementation(async (id) => {
        order.push(`share:${id}`);
      });
      drop([], items);
      expect(handleDropItems).toHaveBeenCalledWith(
        items,
        expect.any(AbortSignal),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "shared_files.added",
        ),
      );
      expect(order).toEqual([
        "import:plain.txt",
        "share:plain.txt",
        "import:folder.zip",
        "share:folder.zip",
      ]);
    },
  );

  it("shares one busy state between drop and picker, and accepts another import after completion", async () => {
    shared();
    const pending = deferred<File[]>();
    vi.mocked(handleDropItems).mockReturnValueOnce(
      pending.promise,
    );
    drop([], [{}]);
    expect(
      screen.getByRole("button", {
        name: "shared_files.add",
      }),
    ).toBeDisabled();
    const other = new File(["other"], "other.txt");
    drop([other]);
    fireEvent.change(
      screen.getByLabelText("shared_files.upload_files"),
      { target: { files: [other] } },
    );
    expect(toast.message).toHaveBeenCalledOnce();
    pending.resolve([new File(["first"], "first.txt")]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "shared_files.add",
        }),
      ).not.toBeDisabled(),
    );
    expect(
      cacheManager.library.importFile,
    ).toHaveBeenCalledOnce();
    drop([other]);
    await waitFor(() =>
      expect(
        cacheManager.library.setShared,
      ).toHaveBeenCalledWith("other.txt", true),
    );
  });

  it.each(["cancel", "switch", "unmount"])(
    "does not share late import results after %s",
    async (action) => {
      const view = shared();
      const pending = deferred<FileImportResult>();
      vi.mocked(
        cacheManager.library.importFile,
      ).mockReturnValueOnce(pending.promise);
      drop([
        new File(["a"], "a.txt"),
        new File(["b"], "b.txt"),
      ]);
      await waitFor(() =>
        expect(
          cacheManager.library.importFile,
        ).toHaveBeenCalledOnce(),
      );
      const signal = vi.mocked(
        cacheManager.library.importFile,
      ).mock.calls[0][1]!.signal!;
      if (action === "cancel") cancelImport();
      else if (action === "switch")
        view.setMember(undefined);
      else view.unmount();
      expect(signal.aborted).toBe(true);
      const toastId = vi.mocked(toast.message).mock
        .calls[0][1]!.id;
      expect(toast.dismiss).toHaveBeenCalledWith(toastId);
      pending.resolve({
        cache: fakeCache("a.txt"),
        reused: false,
      });
      await pending.promise;
      await waitFor(() =>
        expect(
          screen.queryByRole("progressbar"),
        ).not.toBeInTheDocument(),
      );
      expect(
        cacheManager.library.importFile,
      ).toHaveBeenCalledOnce();
      expect(
        cacheManager.library.setShared,
      ).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );

  it("cancels folder preparation before anything is imported", async () => {
    shared();
    const pending = deferred<File[]>();
    vi.mocked(handleDropItems).mockReturnValueOnce(
      pending.promise,
    );
    drop([], [{}]);
    cancelImport();
    pending.resolve([new File(["zip"], "folder.zip")]);
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "shared_files.add",
        }),
      ).not.toBeDisabled(),
    );
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
    expect(
      cacheManager.library.setShared,
    ).not.toHaveBeenCalled();
  });
});
