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
import userEvent from "@testing-library/user-event";
import { SharedFileMenu } from "@/components/files/shared-file-menu";
import { cacheManager } from "@/libs/application/cache-service";
import { handleSelectFolder } from "@/libs/utils/process-file";
import { toast, Toaster } from "solid-sonner";
import { fakeCache } from "../support/file-transfer";
import { deferred } from "../support/rtc-transport";
import type { FileImportResult } from "@/libs/application/file-library-service";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {
    storage: { authorizeDefault: vi.fn(async () => {}) },
    library: {
      importFile: vi.fn(),
      setShared: vi.fn(async () => {}),
      setSharedBatch: vi.fn(async () => {}),
    },
  },
}));
vi.mock("@/libs/utils/process-file", () => ({
  handleSelectFolder: vi.fn(),
}));
vi.mock("@/components/files/file-picker-dialog", () => ({
  default: (props: {
    onSelect(ids: string[]): void;
    onClose(): void;
  }) => (
    <div role="dialog">
      <button
        onClick={() =>
          props.onSelect(["existing-a", "existing-b"])
        }
      >
        Confirm selection
      </button>
      <button onClick={props.onClose}>
        Cancel selection
      </button>
    </div>
  ),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("scrollTo", vi.fn());
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(toast, "message");
  vi.spyOn(toast, "dismiss");
  vi.spyOn(toast, "success");
  vi.spyOn(toast, "error");
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

async function choose(action: string) {
  const user = userEvent.setup();
  await user.click(
    screen.getByRole("button", {
      name: "shared_files.add",
    }),
  );
  await user.click(
    await screen.findByRole("menuitem", { name: action }),
  );
}

describe("shared file header menu", () => {
  it("shares library selections only after confirmation", async () => {
    render(() => <SharedFileMenu />);
    await choose("shared_files.from_library");
    expect(
      cacheManager.library.setSharedBatch,
    ).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByText("Cancel selection"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await choose("shared_files.from_library");
    fireEvent.click(
      await screen.findByText("Confirm selection"),
    );
    expect(
      cacheManager.library.setSharedBatch,
    ).toHaveBeenCalledWith(
      ["existing-a", "existing-b"],
      true,
    );
    expect(
      cacheManager.library.importFile,
    ).not.toHaveBeenCalled();
  });

  it("opens the file picker and shares each file only after successful import", async () => {
    render(() => <SharedFileMenu />);
    const input = screen.getByLabelText(
      "shared_files.upload_files",
    ) as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    await choose("shared_files.upload_files");
    expect(click).toHaveBeenCalledOnce();
    const order: string[] = [];
    vi.mocked(
      cacheManager.library.importFile,
    ).mockImplementation(async (file) => {
      order.push(`import:${file.name}`);
      return { cache: fakeCache(file.name), reused: false };
    });
    vi.mocked(
      cacheManager.library.setShared,
    ).mockImplementation(async (id) => {
      order.push(`share:${id}`);
    });
    const files = [
      new File(["one"], "a.txt"),
      new File(["two"], "b.txt"),
    ];
    fireEvent.change(input, { target: { files } });
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "shared_files.added",
      ),
    );
    expect(order).toEqual([
      "import:a.txt",
      "share:a.txt",
      "import:b.txt",
      "share:b.txt",
    ]);
    expect(input.value).toBe("");
    expect(toast.dismiss).toHaveBeenCalledWith(
      vi.mocked(toast.message).mock.calls[0][1]!.id,
    );
  });

  it("uses the existing folder archive flow before importing and sharing", async () => {
    render(() => <SharedFileMenu />);
    const input = screen.getByLabelText(
      "shared_files.upload_folder",
    ) as HTMLInputElement;
    const click = vi.spyOn(input, "click");
    await choose("shared_files.upload_folder");
    expect(click).toHaveBeenCalledOnce();
    const zip = new File(["archive"], "folder.zip");
    vi.mocked(handleSelectFolder).mockResolvedValueOnce(
      zip,
    );
    const files = [new File(["one"], "a.txt")];
    fireEvent.change(input, { target: { files } });
    await waitFor(() =>
      expect(
        cacheManager.library.setShared,
      ).toHaveBeenCalledWith("folder.zip", true),
    );
    expect(handleSelectFolder).toHaveBeenCalledWith(
      files,
      expect.any(AbortSignal),
    );
    expect(
      cacheManager.library.importFile,
    ).toHaveBeenCalledWith(zip, {
      signal: expect.any(AbortSignal),
      silent: true,
      onImportProgress: expect.any(Function),
    });
  });

  it("does not share when import fails", async () => {
    render(() => <SharedFileMenu />);
    vi.mocked(
      cacheManager.library.importFile,
    ).mockRejectedValueOnce(new Error("Storage full"));
    fireEvent.change(
      screen.getByLabelText("shared_files.upload_files"),
      { target: { files: [new File(["one"], "a.txt")] } },
    );
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "file_import_error.title",
        expect.objectContaining({
          description: expect.stringContaining(
            "Error: Storage full",
          ),
        }),
      ),
    );
    expect(
      cacheManager.library.setShared,
    ).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it.each(["cancel", "unmount"])(
    "does not enable sharing after an import is cancelled by %s",
    async (action) => {
      const view = render(() => <SharedFileMenu />);
      const pending = deferred<FileImportResult>();
      vi.mocked(
        cacheManager.library.importFile,
      ).mockReturnValueOnce(pending.promise);
      fireEvent.change(
        screen.getByLabelText("shared_files.upload_files"),
        { target: { files: [new File(["one"], "a.txt")] } },
      );
      await waitFor(() =>
        expect(
          cacheManager.library.importFile,
        ).toHaveBeenCalledOnce(),
      );
      const signal = vi.mocked(
        cacheManager.library.importFile,
      ).mock.calls[0][1]!.signal!;
      if (action === "unmount") view.unmount();
      else {
        fireEvent.click(
          await screen.findByRole("button", {
            name: "common.action.cancel",
          }),
        );
      }
      expect(signal.aborted).toBe(true);
      pending.resolve({
        cache: fakeCache("a.txt"),
        reused: false,
      });
      await waitFor(() =>
        expect(toast.dismiss).toHaveBeenCalled(),
      );
      expect(
        cacheManager.library.setShared,
      ).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
    },
  );
});
