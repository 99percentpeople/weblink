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
import type { FileStorage } from "@/libs/domain/file-storage";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
const stop = vi.fn();
const mounts = vi.fn<FileStorage["mounts"]>();
const openDirectory = vi.fn<FileStorage["openDirectory"]>();
const storage = {
  mounts,
  openDirectory,
  onChange: () => stop,
} as unknown as FileStorage;
beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  openDirectory.mockResolvedValue(undefined);
  mounts.mockReturnValue([
    {
      id: "indexeddb",
      name: "Browser",
      kind: "indexeddb",
      canOpen: false,
    },
    {
      id: "native-default",
      name: "C:\\Cache",
      kind: "native",
      canOpen: true,
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
  expect(openDirectory).toHaveBeenCalledWith(
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
      canOpen: true,
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
  expect(openDirectory).toHaveBeenCalledWith(
    "native-other",
  );
  expect(
    screen.queryByRole("menuitem", { name: "Browser" }),
  ).not.toBeInTheDocument();
});

it("hides the mounted-directory browse feature in the browser", () => {
  mounts.mockReturnValue([
    mounts()[0],
    {
      id: "directory-mounted",
      name: "Mounted folder",
      kind: "directory",
      canOpen: false,
    },
  ]);
  mount();
  expect(
    screen.queryByRole("button", {
      name: "storage.open_directory",
    }),
  ).not.toBeInTheDocument();
  expect(openDirectory).not.toHaveBeenCalled();
});
