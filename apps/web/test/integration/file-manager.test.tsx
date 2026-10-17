// @vitest-environment jsdom
import { fileCapabilities } from "../support/file-capabilities";
import {
  afterEach,
  beforeEach,
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
import userEvent from "@testing-library/user-event";
import { createSignal, Show } from "solid-js";
import { toast, Toaster } from "solid-sonner";
import { reconcile } from "solid-js/store";
import {
  createFileSaveProgress,
  runFileSaveBatch,
  type FileBatchSaveOptions,
  type FileConflictResolver,
} from "@weblink/platform";
import { NotificationsContext } from "@/libs/state/notifications-context";
import FileManager from "@/components/files/file-manager";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const fixture = vi.hoisted(() => {
  const openDirectory = vi.fn();
  const revealFile = vi.fn();
  return {
    openDirectory,
    revealFile,
    saveFile: vi.fn(),
    saveFileAs: vi.fn(),
    saveFilesAs: vi.fn(),
    downloadFile: vi.fn(),
    openPicker: vi.fn(),
    reportError: vi.fn(),
    notifications: {
      show: vi.fn(async () => {}),
      dismiss: vi.fn(),
    },
    storageState: {
      selected: "indexeddb",
      listeners: new Set<() => void>(),
    },
    platform: {
      filesystem: undefined as
        | {
            openDirectory: typeof openDirectory;
            revealFile: typeof revealFile;
          }
        | undefined,
    },
  };
});
vi.mock("@/libs/platform/runtime", () => ({
  platform: fixture.platform,
}));
vi.mock("@/i18n", () => ({
  t: (key: string, params?: Record<string, unknown>) =>
    key.startsWith("file_save_progress.") && params
      ? `${key}: ${JSON.stringify(params)}`
      : key,
}));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {
    getCache: (id: string) => ({
      reveal: fixture.revealFile,
      getInfo: async () => appState.cache.cacheInfo[id],
    }),
    storage: {
      openDirectory: fixture.openDirectory,
      get defaultMountId() {
        return fixture.storageState.selected;
      },
      mounts: () => [
        {
          id: "native-default",
          name: "Cache",
          kind: "native",
          canOpen: !!fixture.platform.filesystem,
        },
      ],
      onChange: (listener: () => void) => {
        fixture.storageState.listeners.add(listener);
        return () =>
          fixture.storageState.listeners.delete(listener);
      },
    },
  },
}));
vi.mock("@/libs/utils/download-file", () => ({
  saveFile: fixture.saveFile,
  saveFileAs: fixture.saveFileAs,
  saveFilesAs: fixture.saveFilesAs,
  downloadFile: fixture.downloadFile,
}));
vi.mock("@/libs/hooks/create-library-import", () => ({
  createLibraryImport: () => ({
    importing: () => false,
    importFiles: vi.fn(),
    openPicker: fixture.openPicker,
    onDrop: vi.fn(),
  }),
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
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(toast, "error").mockImplementation(
    fixture.reportError,
  );
  vi.stubGlobal("scrollTo", vi.fn());
  fixture.storageState.selected = "indexeddb";
  fixture.platform.filesystem = {
    openDirectory: fixture.openDirectory,
    revealFile: fixture.revealFile,
  };
  fixture.openDirectory.mockResolvedValue(undefined);
  fixture.revealFile.mockResolvedValue(undefined);
  fixture.saveFile.mockResolvedValue(true);
  fixture.saveFileAs.mockResolvedValue(true);
  fixture.saveFilesAs.mockResolvedValue(true);
  setAppState(reconcile(createInitialAppState()));
  setAppState("cache", "status", "ready");
  for (const id of ["alpha", "beta", "partial"]) {
    const file = new File([id], `${id}.txt`);
    setAppState("cache", "cacheInfo", id, {
      id,
      fileName: file.name,
      fileSize: file.size,
      isComplete: id !== "partial",
      capabilities: fileCapabilities.indexeddb,
      storageMountId: "indexeddb",
      file: id === "partial" ? undefined : file,
    });
  }
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const [open, setOpen] = createSignal(true);
  const view = render(() => (
    <NotificationsContext.Provider
      value={fixture.notifications}
    >
      <Toaster theme="light" />
      <Show when={open()}>
        <FileManager />
      </Show>
    </NotificationsContext.Provider>
  ));
  return {
    ...view,
    close: () => setOpen(false),
    reopen: () => setOpen(true),
  };
}

const checkbox = (name: string) =>
  within(screen.getByRole("group", { name })).getByRole(
    "checkbox",
  );

function storageFiles(
  ids: string[],
  kind: "indexeddb" | "directory" | "native",
  mountId = kind === "indexeddb"
    ? "indexeddb"
    : `${kind}-default`,
) {
  for (const id of ids)
    setAppState("cache", "cacheInfo", id, {
      capabilities: fileCapabilities[kind],
      storageMountId: mountId,
    });
  return mountId;
}
function selectStorage(mountId: string) {
  fixture.storageState.selected = mountId;
  fixture.storageState.listeners.forEach((listener) =>
    listener(),
  );
}
function selectDirectoryFiles() {
  selectStorage(
    storageFiles(["alpha", "beta"], "directory"),
  );
}

async function fileMenu(name: string) {
  const row = screen
    .getByTitle(name)
    .closest('[role="listitem"]')! as HTMLElement;
  await userEvent.click(
    within(row).getByRole("button", {
      name: "file_library.actions",
    }),
  );
}

it.each(["indexeddb", "directory", "native"] as const)(
  "shows the save action for the actual %s backend",
  async (kind) => {
    if (kind === "directory")
      fixture.platform.filesystem = undefined;
    selectStorage(storageFiles(["alpha"], kind));
    mount();
    await fileMenu("alpha.txt");
    expect(
      screen.queryByRole("menuitem", {
        name: "file_library.action_download",
      }) !== null,
    ).toBe(kind === "indexeddb");
    expect(
      screen.queryByRole("menuitem", {
        name: "file_library.action_save_as",
      }) !== null,
    ).toBe(kind !== "indexeddb");
    expect(
      screen.queryByRole("menuitem", {
        name: "file_library.action_reveal",
      }) !== null,
    ).toBe(kind === "native");
    await userEvent.click(
      screen.getByRole("menuitem", {
        name:
          kind === "indexeddb"
            ? "file_library.action_download"
            : "file_library.action_save_as",
      }),
    );
    await waitFor(() => {
      const file = appState.cache.cacheInfo.alpha.file;
      if (kind === "indexeddb")
        expect(fixture.downloadFile).toHaveBeenCalledWith(
          file,
          { automatic: true },
        );
      else
        expect(fixture.saveFileAs).toHaveBeenCalledWith(
          file,
        );
    });
  },
);

it.each(["indexeddb", "directory", "native"] as const)(
  "uses the actual %s backend for the batch save label and operation",
  async (kind) => {
    if (kind === "directory")
      fixture.platform.filesystem = undefined;
    selectStorage(storageFiles(["alpha", "beta"], kind));
    mount();
    fireEvent.click(checkbox("alpha.txt"));
    fireEvent.click(checkbox("beta.txt"));
    const download = kind === "indexeddb";
    const button = screen.getByRole("button", {
      name: download
        ? "file_library.action_download"
        : "file_library.action_save_as",
    });
    expect(
      screen.queryByRole("button", {
        name: "common.action.download",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(button);
    const files = [
      appState.cache.cacheInfo.alpha.file,
      appState.cache.cacheInfo.beta.file,
    ];
    await waitFor(() => expect(button).toBeEnabled());
    if (download) {
      expect(fixture.saveFile).toHaveBeenCalledTimes(2);
      for (const file of files)
        expect(fixture.saveFile).toHaveBeenCalledWith(
          file,
          file!.name,
          { automatic: true },
        );
      expect(fixture.saveFilesAs).not.toHaveBeenCalled();
    } else {
      expect(fixture.saveFilesAs).toHaveBeenCalledOnce();
      expect(fixture.saveFilesAs).toHaveBeenCalledWith(
        files,
        expect.any(Function),
        expect.objectContaining({
          signal: expect.any(AbortSignal),
          onProgress: expect.any(Function),
        }),
      );
      expect(fixture.saveFile).not.toHaveBeenCalled();
    }
  },
);

it("saves the whole directory selection to one destination and keeps the original batch while saving", async () => {
  selectDirectoryFiles();
  let finish!: (saved: boolean) => void;
  fixture.saveFilesAs.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve) => {
        finish = resolve;
      }),
  );
  mount();
  fireEvent.click(checkbox("alpha.txt"));
  fireEvent.click(checkbox("beta.txt"));
  const button = screen.getByRole("button", {
    name: "file_library.action_save_as",
  });
  fireEvent.click(button);
  expect(button).toBeDisabled();
  expect(fixture.saveFilesAs).toHaveBeenCalledWith(
    [
      appState.cache.cacheInfo.alpha.file,
      appState.cache.cacheInfo.beta.file,
    ],
    expect.any(Function),
    expect.objectContaining({
      signal: expect.any(AbortSignal),
      onProgress: expect.any(Function),
    }),
  );
  expect(fixture.saveFile).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "file_library.select_all",
    }),
  );
  finish(true);
  fireEvent.click(checkbox("beta.txt"));
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: "file_library.action_save_as",
      }),
    ).toBeEnabled(),
  );
  expect(fixture.saveFilesAs).toHaveBeenCalledOnce();
  expect(fixture.saveFile).not.toHaveBeenCalled();
});

it("stops a directory batch on cancellation and allows another attempt", async () => {
  selectDirectoryFiles();
  fixture.saveFilesAs.mockResolvedValueOnce(false);
  mount();
  fireEvent.click(checkbox("alpha.txt"));
  fireEvent.click(checkbox("beta.txt"));
  const button = screen.getByRole("button", {
    name: "file_library.action_save_as",
  });
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(fixture.saveFile).not.toHaveBeenCalled();
  fireEvent.click(button);
  await waitFor(() => expect(button).toBeEnabled());
  expect(fixture.saveFilesAs).toHaveBeenCalledTimes(2);
  expect(fixture.saveFile).not.toHaveBeenCalled();
});

function beginProgressSave() {
  selectDirectoryFiles();
  let finish!: (saved: boolean) => void;
  let fail!: (error: Error) => void;
  fixture.saveFilesAs.mockImplementationOnce(
    () =>
      new Promise<boolean>((resolve, reject) => {
        finish = resolve;
        fail = reject;
      }),
  );
  const view = mount();
  fireEvent.click(checkbox("alpha.txt"));
  fireEvent.click(checkbox("beta.txt"));
  const save = screen.getByRole("button", {
    name: "file_library.action_save_as",
  });
  fireEvent.click(save);
  const [files, , options] = fixture.saveFilesAs.mock
    .calls[0] as [File[], unknown, FileBatchSaveOptions];
  return { ...view, save, files, options, finish, fail };
}

it("shows the current file and byte progress independently of selection, and waits for commit to show 100 percent", async () => {
  const { files, options, finish } = beginProgressSave();
  const panel = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  const progress = () =>
    within(panel).getByRole("progressbar");
  expect(progress()).toHaveAttribute("aria-valuenow", "0");
  const current = {
    ...createFileSaveProgress(files),
    fileName: "beta.txt",
    fileIndex: 2,
    fileSize: 4,
    fileBytesWritten: 2,
    processedBytes: 7,
    savedFiles: 1,
  };
  options.onProgress!(current);
  expect(
    within(panel).getByTitle("beta.txt"),
  ).toHaveTextContent('"index":2,"total":2');
  expect(
    within(panel).getByText("2.00 B / 4.00 B"),
  ).toBeInTheDocument();
  expect(progress()).toHaveAttribute("aria-valuenow", "77");
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "file_library.select_all",
    }),
  );
  expect(panel).toBeInTheDocument();
  expect(
    within(panel).getByRole("button", {
      name: "file_save_progress.cancel_remaining",
    }),
  ).toBeEnabled();
  options.onProgress!({
    ...current,
    fileBytesWritten: 4,
    processedBytes: 9,
  });
  expect(progress()).toHaveAttribute("aria-valuenow", "99");
  options.onProgress!({
    ...current,
    fileBytesWritten: 4,
    processedBytes: 9,
    savedFiles: 2,
  });
  finish(true);
  await within(panel).findByText(
    "file_save_progress.completed",
  );
  expect(progress()).toHaveAttribute(
    "aria-valuenow",
    "100",
  );
  expect(
    within(panel).getByText(
      'file_save_progress.counts: {"saved":2,"skipped":0,"total":2}',
    ),
  ).toBeInTheDocument();
  fireEvent.click(
    within(panel).getByRole("button", {
      name: "common.action.close",
    }),
  );
  await waitFor(() =>
    expect(panel).not.toBeInTheDocument(),
  );
});

it("cancels the active batch, waits for cleanup, and keeps saved/skipped counts without an error toast", async () => {
  const { save, files, options, finish } =
    beginProgressSave();
  options.onProgress!({
    ...createFileSaveProgress(files),
    fileName: "beta.txt",
    fileIndex: 2,
    fileSize: 4,
    savedFiles: 1,
    processedBytes: 5,
  });
  const panel = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  const cancel = within(panel).getByRole("button", {
    name: "file_save_progress.cancel_remaining",
  });
  fireEvent.click(cancel);
  expect(options.signal!.aborted).toBe(true);
  expect(cancel).toBeDisabled();
  expect(save).toBeDisabled();
  expect(
    within(panel).getByRole("status"),
  ).toHaveTextContent("file_save_progress.cancelling");
  finish(false);
  await waitFor(() => expect(save).toBeEnabled());
  expect(
    within(panel).getByRole("status"),
  ).toHaveTextContent("file_save_progress.cancelled");
  expect(
    within(panel).getByText(
      'file_save_progress.counts: {"saved":1,"skipped":0,"total":2}',
    ),
  ).toBeInTheDocument();
  expect(fixture.reportError).not.toHaveBeenCalled();
  fireEvent.click(save);
  await waitFor(() =>
    expect(fixture.saveFilesAs).toHaveBeenCalledTimes(2),
  );
  const retry = fixture.saveFilesAs.mock
    .calls[1][2] as FileBatchSaveOptions;
  expect(retry.signal!.aborted).toBe(false);
});

it("continues saving and updating its toast after the file manager closes", async () => {
  const { files, options, finish, close } =
    beginProgressSave();
  const progress = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  const id = toast.getToasts()[0].id;
  close();
  expect(
    screen.queryByRole("group", { name: "alpha.txt" }),
  ).toBeNull();
  expect(options.signal!.aborted).toBe(false);
  expect(progress).toBeInTheDocument();
  options.onProgress!({
    ...createFileSaveProgress(files),
    fileName: "beta.txt",
    fileIndex: 2,
    fileSize: 4,
    fileBytesWritten: 2,
    savedFiles: 1,
    processedBytes: 7,
  });
  expect(
    within(progress).getByTitle("beta.txt"),
  ).toBeInTheDocument();
  expect(
    within(progress).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "77");
  options.onProgress!({
    ...createFileSaveProgress(files),
    savedFiles: 2,
    processedBytes: 9,
  });
  finish(true);
  await within(progress).findByText(
    "file_save_progress.completed",
  );
  expect(
    within(progress).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "100");
  expect(toast.getToasts().map((item) => item.id)).toEqual([
    id,
  ]);
  expect(fixture.reportError).not.toHaveBeenCalled();
});

it("keeps the progress toast cancellable after the file manager closes", async () => {
  const { options, finish, close } = beginProgressSave();
  close();
  expect(options.signal!.aborted).toBe(false);
  fireEvent.click(
    screen.getByRole("button", {
      name: "file_save_progress.cancel_remaining",
    }),
  );
  expect(options.signal!.aborted).toBe(true);
  finish(false);
  await screen.findByText("file_save_progress.cancelled");
  expect(fixture.reportError).not.toHaveBeenCalled();
});

it("shows and resolves new conflicts after the file manager has already closed", async () => {
  const { options, finish, close } = beginProgressSave();
  const resolveConflict = fixture.saveFilesAs.mock
    .calls[0][1] as FileConflictResolver;
  close();
  const answer = resolveConflict({
    fileName: "later.txt",
    canOverwrite: true,
  });
  const progress = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  const conflict = screen.getByRole("region", {
    name: "file_save_conflict.title",
  });
  expect(
    within(progress).getByRole("status"),
  ).toHaveTextContent("file_save_progress.waiting");
  expect(fixture.notifications.show).toHaveBeenCalledOnce();
  expect(
    fixture.notifications.dismiss,
  ).not.toHaveBeenCalled();
  fireEvent.click(
    within(conflict).getByRole("button", {
      name: "file_save_conflict.skip",
    }),
  );
  expect(await answer).toBe("skip");
  expect(
    within(progress).getByRole("status"),
  ).toHaveTextContent("file_save_progress.saving");
  expect(options.signal!.aborted).toBe(false);
  finish(true);
  await within(progress).findByText(
    "file_save_progress.completed",
  );
  await waitFor(() =>
    expect(conflict).not.toBeInTheDocument(),
  );
});

it("reports a background save failure after the file manager closes", async () => {
  const { fail, close } = beginProgressSave();
  close();
  fail(new Error("Disk full"));
  await screen.findByText("file_save_progress.failed");
  expect(screen.getByRole("alert")).toHaveTextContent(
    "errors.file_failed",
  );
  expect(fixture.reportError).not.toHaveBeenCalled();
});

it("keeps earlier batch notices and cancellation independent when another save starts after reopening", async () => {
  const { options, finish, close, reopen } =
    beginProgressSave();
  const original = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  close();
  reopen();
  expect(toast.getToasts()).toHaveLength(1);
  fireEvent.click(checkbox("beta.txt"));
  fireEvent.click(
    screen.getByRole("button", {
      name: "file_library.action_save_as",
    }),
  );
  await screen.findByText("file_save_progress.completed");
  expect(fixture.saveFilesAs).toHaveBeenCalledTimes(2);
  expect(toast.getToasts()).toHaveLength(2);
  expect(original).toBeInTheDocument();
  expect(options.signal!.aborted).toBe(false);
  fireEvent.click(
    within(original).getByRole("button", {
      name: "file_save_progress.cancel_remaining",
    }),
  );
  expect(options.signal!.aborted).toBe(true);
  expect(
    (
      fixture.saveFilesAs.mock
        .calls[1][2] as FileBatchSaveOptions
    ).signal!.aborted,
  ).toBe(false);
  finish(false);
  await within(original).findByText(
    "file_save_progress.cancelled",
  );
});

it("keeps failures distinct from cancellation and permits retry", async () => {
  const { save, fail } = beginProgressSave();
  fail(new Error("Disk full"));
  await waitFor(() => expect(save).toBeEnabled());
  const panel = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  expect(
    within(panel).getByRole("status"),
  ).toHaveTextContent("file_save_progress.failed");
  expect(
    within(panel).getByRole("alert"),
  ).toHaveTextContent("errors.file_failed");
  expect(fixture.reportError).not.toHaveBeenCalled();
});

it("advances empty-file batches using saved and skipped counts", async () => {
  for (const id of ["alpha", "beta"]) {
    setAppState(
      "cache",
      "cacheInfo",
      id,
      "file",
      new File([], `${id}.txt`),
    );
    setAppState("cache", "cacheInfo", id, "fileSize", 0);
  }
  const { files, options, finish } = beginProgressSave();
  const current = {
    ...createFileSaveProgress(files),
    fileName: "alpha.txt",
    fileIndex: 1,
    savedFiles: 1,
  };
  options.onProgress!(current);
  const panel = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  expect(
    within(panel).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "50");
  options.onProgress!({
    ...current,
    fileName: "beta.txt",
    fileIndex: 2,
    skippedFiles: 1,
  });
  finish(true);
  await within(panel).findByText(
    "file_save_progress.completed",
  );
  expect(
    within(panel).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "100");
  expect(
    within(panel).getByText(
      'file_save_progress.counts: {"saved":1,"skipped":1,"total":2}',
    ),
  ).toBeInTheDocument();
});

it("retains a pending conflict and continues the original batch after closing and reopening the file manager", async () => {
  selectDirectoryFiles();
  let commit!: () => void;
  const ready = new Promise<void>((resolve) => {
    commit = resolve;
  });
  const written: string[] = [];
  fixture.saveFilesAs.mockImplementationOnce(
    (
      files,
      resolveConflict: FileConflictResolver,
      options,
    ) =>
      runFileSaveBatch(
        files,
        async (file, onWritten) => {
          if (file.name === "alpha.txt") {
            const action = await resolveConflict({
              fileName: file.name,
              canOverwrite: true,
            });
            if (!action) return "cancelled";
            expect(action).toBe("keep_both");
          }
          written.push(file.name);
          onWritten(file.size);
          await ready;
          return "saved";
        },
        options,
      ),
  );
  const view = mount();
  fireEvent.click(checkbox("alpha.txt"));
  fireEvent.click(checkbox("beta.txt"));
  fireEvent.click(
    screen.getByRole("button", {
      name: "file_library.action_save_as",
    }),
  );
  const progress = screen.getByRole("region", {
    name: "file_save_progress.title",
  });
  const conflict = screen.getByRole("region", {
    name: "file_save_conflict.title",
  });
  const ids = toast.getToasts().map((item) => item.id);
  expect(ids).toHaveLength(2);
  expect(written).toEqual([]);
  expect(
    within(progress).getByRole("status"),
  ).toHaveTextContent("file_save_progress.waiting");
  expect(
    within(progress).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "0");
  expect(fixture.notifications.show).toHaveBeenCalledOnce();
  expect(fixture.notifications.show).toHaveBeenCalledWith(
    expect.objectContaining({ category: "transfers" }),
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  view.close();
  expect(
    screen.queryByRole("group", { name: "alpha.txt" }),
  ).toBeNull();
  expect(conflict).toBeInTheDocument();
  expect(progress).toBeInTheDocument();
  expect(
    fixture.notifications.dismiss,
  ).not.toHaveBeenCalled();
  fireEvent.click(
    within(conflict).getByRole("button", {
      name: "file_save_conflict.keep_both",
    }),
  );
  await waitFor(() =>
    expect(written).toEqual(["alpha.txt"]),
  );
  expect(
    within(progress).getByRole("status"),
  ).toHaveTextContent("file_save_progress.saving");
  expect(toast.getToasts().map((item) => item.id)).toEqual([
    ids.find((id) =>
      String(id).startsWith("file-save-progress:"),
    ),
  ]);
  view.reopen();
  expect(fixture.saveFilesAs).toHaveBeenCalledOnce();
  expect(progress).toBeInTheDocument();
  commit();
  await within(progress).findByText(
    "file_save_progress.completed",
  );
  expect(written).toEqual(["alpha.txt", "beta.txt"]);
  expect(
    within(progress).getByRole("progressbar"),
  ).toHaveAttribute("aria-valuenow", "100");
  expect(toast.getToasts()).toHaveLength(1);
  expect(toast.getToasts()[0]).toMatchObject({
    duration: 4000,
    dismissible: true,
  });
  view.close();
  expect(toast.getToasts()).toHaveLength(1);
});

it.each([
  "file_save_progress.cancel_remaining",
  "common.action.cancel",
])(
  "cancels a background batch from %s while waiting for a conflict",
  async (action) => {
    selectDirectoryFiles();
    const written = vi.fn();
    fixture.saveFilesAs.mockImplementationOnce(
      (
        files,
        resolveConflict: FileConflictResolver,
        options,
      ) =>
        runFileSaveBatch(
          files,
          async (file) => {
            const answer = await resolveConflict({
              fileName: file.name,
              canOverwrite: true,
            });
            if (!answer) return "cancelled";
            written(file.name);
            return "saved";
          },
          options,
        ),
    );
    const view = mount();
    fireEvent.click(checkbox("alpha.txt"));
    fireEvent.click(checkbox("beta.txt"));
    const save = screen.getByRole("button", {
      name: "file_library.action_save_as",
    });
    fireEvent.click(save);
    const conflict = screen.getByRole("region", {
      name: "file_save_conflict.title",
    });
    view.close();
    fireEvent.click(
      screen.getByRole("button", {
        name: action,
      }),
    );
    await screen.findByText("file_save_progress.cancelled");
    expect(
      screen.getByText("file_save_progress.cancelled"),
    ).toBeInTheDocument();
    expect(written).not.toHaveBeenCalled();
    expect(
      fixture.notifications.dismiss,
    ).toHaveBeenCalledOnce();
    expect(toast.getToasts()).toHaveLength(1);
    await waitFor(() =>
      expect(conflict).not.toBeInTheDocument(),
    );
  },
);

it("reveals unfinished physical files without opening or exporting their bytes", async () => {
  selectStorage(
    storageFiles(["partial"], "native", "native-other"),
  );
  mount();
  await fileMenu("partial.txt");
  await userEvent.click(
    screen.getByRole("menuitem", {
      name: "file_library.action_reveal",
    }),
  );
  await waitFor(() =>
    expect(fixture.revealFile).toHaveBeenCalledOnce(),
  );
  expect(fixture.downloadFile).not.toHaveBeenCalled();
  expect(fixture.saveFileAs).not.toHaveBeenCalled();
});

it("selects filtered cache files including incomplete files, and clears hidden selections too", () => {
  mount();
  const selectAll = screen.getByRole("checkbox", {
    name: "file_library.select_all",
  });
  expect(selectAll).not.toBeChecked();
  expect(selectAll).not.toBePartiallyChecked();
  fireEvent.click(checkbox("alpha.txt"));
  expect(selectAll).toBePartiallyChecked();
  const search = screen.getByRole("textbox", {
    name: "file_library.search",
  });
  fireEvent.input(search, { target: { value: "partial" } });
  fireEvent.click(selectAll);
  expect(checkbox("partial.txt")).toBeChecked();
  expect(selectAll).toBeChecked();
  expect(
    screen.getByRole("button", {
      name: "common.action.send",
    }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", {
      name: "file_library.action_download",
    }),
  ).toBeDisabled();
  fireEvent.input(search, { target: { value: "" } });
  expect(checkbox("alpha.txt")).toBeChecked();
  expect(checkbox("beta.txt")).not.toBeChecked();
  expect(selectAll).toBePartiallyChecked();
  fireEvent.click(selectAll);
  expect(checkbox("beta.txt")).toBeChecked();
  fireEvent.input(search, { target: { value: "partial" } });
  fireEvent.click(selectAll);
  expect(selectAll).not.toBeChecked();
  expect(selectAll).not.toBePartiallyChecked();
  fireEvent.input(search, { target: { value: "" } });
  for (const name of [
    "alpha.txt",
    "beta.txt",
    "partial.txt",
  ])
    expect(checkbox(name)).not.toBeChecked();
  expect(
    screen.queryByRole("button", {
      name: "common.action.send",
    }),
  ).not.toBeInTheDocument();
  fireEvent.input(search, {
    target: { value: "no matches" },
  });
  expect(selectAll).toBeDisabled();
  fireEvent.input(search, { target: { value: "" } });
  fireEvent.click(checkbox("alpha.txt"));
  fireEvent.input(search, {
    target: { value: "no matches" },
  });
  expect(selectAll).toBePartiallyChecked();
  expect(selectAll).toBeEnabled();
  fireEvent.click(selectAll);
  expect(selectAll).toBeDisabled();
  expect(selectAll).not.toBePartiallyChecked();
  fireEvent.input(search, { target: { value: "" } });
  expect(checkbox("alpha.txt")).not.toBeChecked();
});

it.each([false, true])(
  "keeps import directly accessible independently of directory opening (desktop=%s)",
  async (desktop) => {
    if (!desktop) fixture.platform.filesystem = undefined;
    mount();
    const open = screen.queryByRole("button", {
      name: "storage.open_directory",
    });
    expect(open !== null).toBe(desktop);
    if (open) {
      await userEvent.click(open);
      expect(fixture.openDirectory).toHaveBeenCalledWith(
        "native-default",
      );
    }
    await userEvent.click(
      screen.getByRole("button", {
        name: "file_library.import",
      }),
    );
    expect(
      screen.queryByRole("menuitem", {
        name: "storage.open_directory",
      }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", {
        name: "shared_files.upload_folder",
      }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("menuitem", {
        name: "shared_files.upload_files",
      }),
    );
    expect(fixture.openPicker).toHaveBeenCalledWith(
      screen.getByLabelText("shared_files.upload_files"),
    );
  },
);

it.each(["directory", "native"] as const)(
  "updates the open cache list and clears old selections when changing %s directories",
  async (kind) => {
    if (kind === "directory")
      fixture.platform.filesystem = undefined;
    const first = storageFiles(
      ["alpha", "partial"],
      kind,
      `${kind}-first`,
    );
    const second = storageFiles(
      ["beta"],
      kind,
      `${kind}-second`,
    );
    const legacy = new File(["legacy"], "legacy.txt");
    setAppState("cache", "cacheInfo", "legacy", {
      id: "legacy",
      fileName: legacy.name,
      storageMountId: "indexeddb",
      capabilities: fileCapabilities.indexeddb,
      fileSize: legacy.size,
      file: legacy,
      isComplete: true,
    });
    selectStorage(first);
    const view = mount();
    expect(
      screen.getByTitle("alpha.txt"),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("partial.txt"),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("beta.txt")).toBeNull();
    expect(screen.queryByTitle("legacy.txt")).toBeNull();
    fireEvent.click(checkbox("alpha.txt"));
    selectStorage(second);
    expect(screen.queryByTitle("alpha.txt")).toBeNull();
    expect(screen.queryByTitle("partial.txt")).toBeNull();
    expect(
      screen.getByTitle("beta.txt"),
    ).toBeInTheDocument();
    expect(checkbox("beta.txt")).not.toBeChecked();
    expect(
      screen.queryByRole("button", {
        name: "common.action.send",
      }),
    ).toBeNull();
    fireEvent.click(checkbox("beta.txt"));
    const save = screen.getByRole("button", {
      name: "file_library.action_save_as",
    });
    fireEvent.click(save);
    await waitFor(() => expect(save).toBeEnabled());
    expect(fixture.saveFilesAs).toHaveBeenCalledWith(
      [appState.cache.cacheInfo.beta.file],
      expect.any(Function),
      expect.anything(),
    );
    selectStorage(`${kind}-empty`);
    expect(screen.queryByTitle("beta.txt")).toBeNull();
    expect(
      screen.getByText("file_library.empty"),
    ).toBeInTheDocument();
    selectStorage("indexeddb");
    expect(
      screen.getByTitle("legacy.txt"),
    ).toBeInTheDocument();
    expect(screen.queryByTitle("alpha.txt")).toBeNull();
    selectStorage(first);
    expect(
      screen.getByTitle("alpha.txt"),
    ).toBeInTheDocument();
    expect(
      screen.getByTitle("partial.txt"),
    ).toBeInTheDocument();
    expect(checkbox("alpha.txt")).not.toBeChecked();
    expect(
      appState.cache.cacheInfo.beta.file,
    ).toBeDefined();
    view.unmount();
    expect(fixture.storageState.listeners.size).toBe(0);
  },
);
