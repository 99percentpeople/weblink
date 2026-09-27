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
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import FileManager from "@/components/files/file-manager";
import { SharedFilesPanel } from "@/components/files/shared-files-panel";
import { cacheManager } from "@/libs/application/cache-service";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { handleDropItems } from "@/libs/utils/process-file";
import { toast } from "solid-sonner";
import { fakeCache } from "../support/file-transfer";
import { deferred } from "../support/rtc-transport";
import type { FileImportResult } from "@/libs/application/file-library-service";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconClose: () => null,
  IconPlaceItem: () => null,
}));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {
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
vi.mock("solid-sonner", () => ({
  toast: {
    loading: vi.fn(),
    dismiss: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
  },
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
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  setAppState(reconcile(createInitialAppState()));
  setAppState("profile", "clientId", "local");
  vi.mocked(toast.loading).mockReturnValue("import-toast");
  vi.mocked(
    cacheManager.library.importFile,
  ).mockImplementation(async (file) => ({
    cache: fakeCache(file.name),
    reused: false,
  }));
});
afterEach(() => {
  cleanup();
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

function drop(files: File[], items?: unknown[]) {
  return fireEvent.drop(
    screen.getByRole("searchbox", { name: "Files" }),
    {
      dataTransfer: { types: ["Files"], files, items },
    },
  );
}
function cancelImport() {
  const action = vi.mocked(toast.loading).mock.calls[0][1]!
    .action;
  if (
    !action ||
    typeof action !== "object" ||
    !("onClick" in action)
  )
    throw new Error("Missing import cancel action");
  action.onClick(new MouseEvent("click") as never);
}

describe("library file drop integration", () => {
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
    expect(toast.loading).toHaveBeenCalledOnce();
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
      expect(toast.dismiss).toHaveBeenCalledWith(
        "import-toast",
      );
      pending.resolve({
        cache: fakeCache("a.txt"),
        reused: false,
      });
      await waitFor(() =>
        expect(toast.dismiss).toHaveBeenCalledTimes(2),
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
