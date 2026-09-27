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
  within,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import FilePickerDialog from "@/components/files/file-picker-dialog";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: { initialize: vi.fn() },
}));

beforeEach(() => {
  vi.stubGlobal("scrollTo", vi.fn());
  setAppState(reconcile(createInitialAppState()));
  setAppState("cache", "status", "ready");
  for (const id of [
    "private",
    "shared",
    "partial",
    "missing",
    "empty",
  ]) {
    const file = new File(
      id === "empty" ? [] : [id],
      `${id}.txt`,
    );
    setAppState("cache", "cacheInfo", id, {
      id,
      fileName: file.name,
      fileSize: file.size,
      isComplete: id !== "partial",
      isShared: id === "shared",
      file: id === "missing" ? undefined : file,
    });
  }
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const checkbox = (name: string) =>
  within(screen.getByRole("group", { name })).getByRole(
    "checkbox",
  );

describe("library file selection eligibility", () => {
  it.each([false, true])(
    "filters the %s sharing picker and removes selections that become ineligible",
    async (sharing) => {
      const select = vi.fn();
      render(() => (
        <FilePickerDialog
          open
          sharing={sharing}
          onClose={() => {}}
          onSelect={select}
        />
      ));
      await screen.findByTitle("private.txt");
      expect(
        screen.queryByTitle("shared.txt") !== null,
      ).toBe(!sharing);
      expect(screen.queryByTitle("partial.txt")).toBeNull();
      expect(screen.queryByTitle("missing.txt")).toBeNull();
      // Zero-byte files are available too; availability depends on complete local bytes.
      fireEvent.click(checkbox("empty.txt"));
      fireEvent.click(checkbox("private.txt"));
      if (sharing)
        setAppState(
          "cache",
          "cacheInfo",
          "private",
          "isShared",
          true,
        );
      else
        setAppState(
          "cache",
          "cacheInfo",
          "private",
          "file",
          undefined,
        );
      expect(screen.queryByTitle("private.txt")).toBeNull();
      if (sharing)
        setAppState(
          "cache",
          "cacheInfo",
          "private",
          "isShared",
          false,
        );
      else
        setAppState(
          "cache",
          "cacheInfo",
          "private",
          "file",
          new File(["private"], "private.txt"),
        );
      expect(checkbox("private.txt")).not.toBeChecked();
      fireEvent.click(
        screen.getByRole("button", {
          name: sharing
            ? "shared_files.share_count"
            : "file_library.send_count",
        }),
      );
      expect(select).toHaveBeenCalledWith(["empty"]);
    },
  );
});
