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
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { MountedDirectoryMenu } from "@/components/files/mounted-directory-menu";
import type { FileStorageService } from "@/libs/application/file-storage-service";

const fixture = vi.hoisted(() => {
  const openDirectory = vi.fn();
  return {
    openDirectory,
    platform: {
      filesystem: undefined as
        | { openDirectory: typeof openDirectory }
        | undefined,
    },
  };
});
vi.mock("@/libs/platform/runtime", () => ({
  platform: fixture.platform,
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
const stop = vi.fn();
const mounts = vi.fn();
const storage = {
  mounts,
  onChange: () => stop,
} as unknown as FileStorageService;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  fixture.platform.filesystem = {
    openDirectory: fixture.openDirectory,
  };
  fixture.openDirectory.mockResolvedValue(undefined);
  mounts.mockReturnValue([
    { id: "indexeddb", name: "Browser", kind: "indexeddb" },
    {
      id: "native-default",
      name: "C:\\Cache",
      kind: "native",
    },
  ]);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
function mount() {
  return render(() => (
    <MountedDirectoryMenu storage={storage} />
  ));
}

it("opens a single mounted root directly with the system file manager and releases its subscription", async () => {
  const view = mount();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "storage.open_directory",
    }),
  );
  expect(fixture.openDirectory).toHaveBeenCalledWith(
    "native-default",
  );
  view.unmount();
  expect(stop).toHaveBeenCalledOnce();
});

it("lets the user choose among native mounts and never presents IndexedDB as a directory", async () => {
  mounts.mockReturnValue([
    ...mounts(),
    {
      id: "native-other",
      name: "D:\\Received",
      kind: "native",
    },
  ]);
  mount();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "storage.open_directory",
    }),
  );
  await userEvent.click(
    await screen.findByRole("menuitem", {
      name: "D:\\Received",
    }),
  );
  expect(fixture.openDirectory).toHaveBeenCalledWith(
    "native-other",
  );
  expect(
    screen.queryByRole("menuitem", { name: "Browser" }),
  ).not.toBeInTheDocument();
});

it("hides the mounted-directory browse feature in the browser", () => {
  fixture.platform.filesystem = undefined;
  mount();
  expect(
    screen.queryByRole("button", {
      name: "storage.open_directory",
    }),
  ).not.toBeInTheDocument();
  expect(fixture.openDirectory).not.toHaveBeenCalled();
});
