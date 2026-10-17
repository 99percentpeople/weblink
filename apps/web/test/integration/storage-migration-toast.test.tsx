// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { toast, Toaster } from "solid-sonner";
import { StorageMigrationToast } from "@/components/files/storage-migration-toast";
import type { FileStorageService } from "@/libs/application/file-storage-service";
import type { StorageMigrationProgress } from "@/libs/domain/storage-migration";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/cache-service", () => ({
  createCacheManager: vi.fn(),
}));
const initial: StorageMigrationProgress = {
  phase: "copying",
  fileName: "old.pdf",
  totalFiles: 2,
  completedFiles: 0,
  bytes: 128,
  totalBytes: 256,
  failures: [],
};
beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(toast, "message");
  render(() => <Toaster theme="light" />);
});
afterEach(() => {
  cleanup();
  toast.dismiss();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture(current?: StorageMigrationProgress) {
  const listeners = new Set<
    (state: StorageMigrationProgress) => void
  >();
  const dispose = vi.fn();
  const storage = {
    dispose,
    onMigrationProgress(
      listener: (state: StorageMigrationProgress) => void,
    ) {
      listeners.add(listener);
      if (current) listener(current);
      return () => {
        listeners.delete(listener);
      };
    },
  } as unknown as FileStorageService;
  const view = render(() => (
    <StorageMigrationToast storage={storage} />
  ));
  return {
    ...view,
    dispose,
    listeners,
    update(state: Partial<StorageMigrationProgress>) {
      current = { ...(current ?? initial), ...state };
      listeners.forEach((listener) => listener(current!));
    },
  };
}
it("does not show a migration toast for installations without old files", () => {
  fixture();
  expect(toast.message).not.toHaveBeenCalled();
});
it("replays startup progress and updates one compact toast through verification and completion", async () => {
  const f = fixture(initial);
  expect(
    await screen.findByText("old.pdf"),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("progressbar"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("storage_migration.copying"),
  ).toBeInTheDocument();
  expect(toast.message).toHaveBeenCalledTimes(1);
  f.update({ phase: "verifying", bytes: 256 });
  expect(
    screen.getByText("storage_migration.verifying"),
  ).toBeInTheDocument();
  expect(toast.message).toHaveBeenCalledTimes(1);
  f.update({ phase: "completed", completedFiles: 2 });
  await waitFor(() =>
    expect(
      screen.getByText("storage_migration.completed"),
    ).toBeInTheDocument(),
  );
  expect(toast.message).toHaveBeenLastCalledWith(
    expect.any(Function),
    expect.objectContaining({
      id: "indexeddb-migration",
      duration: 5000,
      dismissible: true,
    }),
  );
});
it("keeps blocked migration visible and explains how to release the old connection", async () => {
  fixture({ ...initial, phase: "waiting" });
  expect(
    await screen.findByText(
      "storage_migration.close_other_tabs",
    ),
  ).toBeInTheDocument();
  expect(toast.message).toHaveBeenLastCalledWith(
    expect.any(Function),
    expect.objectContaining({
      duration: Infinity,
      dismissible: false,
    }),
  );
  expect(
    screen.queryByText("storage_migration.completed"),
  ).not.toBeInTheDocument();
});
it("retains failure details and reports that old databases are preserved for retry", async () => {
  fixture({
    ...initial,
    phase: "failed",
    failures: [
      {
        id: "old-id",
        fileName: "old.pdf",
        error: "QuotaExceededError: Disk full",
      },
    ],
  });
  expect(
    await screen.findByText("storage_migration.retained"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(/QuotaExceededError/),
  ).toBeInTheDocument();
  expect(toast.message).toHaveBeenLastCalledWith(
    expect.any(Function),
    expect.objectContaining({
      duration: Infinity,
      dismissible: true,
    }),
  );
});
it("view cleanup unsubscribes without cancelling storage migration", () => {
  const f = fixture(initial);
  f.unmount();
  expect(f.listeners.size).toBe(0);
  expect(f.dispose).not.toHaveBeenCalled();
});
