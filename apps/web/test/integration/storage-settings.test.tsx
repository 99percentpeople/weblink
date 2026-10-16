// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
import userEvent from "@testing-library/user-event";
import type { VfsVolumeInfo } from "@weblink/platform";
import StorageSettings from "@/components/settings/storage-settings";

const fixture = vi.hoisted(() => {
  const state = {
    selected: "indexeddb",
    mounts: [] as VfsVolumeInfo[],
    canMount: true,
    listeners: new Set<() => void>(),
  };
  const stat = vi.fn();
  const storage = {
    get defaultMountId() {
      return state.selected;
    },
    get canMountDirectory() {
      return state.canMount;
    },
    mounts: () => [...state.mounts],
    initialize: vi.fn(),
    onChange: (listener: () => void) => {
      state.listeners.add(listener);
      return () => state.listeners.delete(listener);
    },
    setDefault: vi.fn(),
    mountDirectory: vi.fn(),
    getVolume: vi.fn(),
    authorize: vi.fn(),
  };
  const openDirectory = vi.fn();
  const platform = {
    kind: "browser" as "browser" | "desktop",
    filesystem: undefined as
      | { openDirectory: typeof openDirectory }
      | undefined,
  };
  return {
    state,
    storage,
    platform,
    stat,
    openDirectory,
    openFiles: vi.fn(),
  };
});
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/cache-service", () => ({
  createCacheManager: () => ({ storage: fixture.storage }),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: fixture.platform,
}));
vi.mock("@/libs/state/app-dialogs-context", () => ({
  useAppDialogs: () => ({ openFiles: fixture.openFiles }),
}));

const directory: VfsVolumeInfo = {
  id: "directory-files",
  name: "D:\\Weblink Files",
  kind: "directory",
};
const changed = () =>
  fixture.state.listeners.forEach((listener) => listener());
beforeEach(() => {
  vi.resetAllMocks();
  fixture.state.selected = "indexeddb";
  fixture.state.mounts = [
    { id: "indexeddb", name: "Browser", kind: "indexeddb" },
  ];
  fixture.state.canMount = true;
  fixture.platform.kind = "browser";
  fixture.platform.filesystem = undefined;
  fixture.storage.initialize.mockResolvedValue(undefined);
  fixture.stat.mockResolvedValue({ kind: "directory" });
  fixture.storage.getVolume.mockResolvedValue({
    stat: fixture.stat,
  });
  fixture.storage.setDefault.mockImplementation(
    async (id: string) => {
      fixture.state.selected = id;
      changed();
    },
  );
  fixture.storage.authorize.mockImplementation(async () => {
    fixture.stat.mockResolvedValue({ kind: "directory" });
    changed();
  });
});
afterEach(cleanup);

async function mount() {
  render(() => <StorageSettings />);
  await waitFor(() => expect(modeButton()).toBeEnabled());
}
const modeButton = () =>
  screen.getByRole("button", { name: /^storage\.default/ });
async function chooseMode(
  name: "storage.browser" | "storage.local_directory",
) {
  await userEvent.click(modeButton());
  await userEvent.click(
    await screen.findByRole("option", { name }),
  );
  await waitFor(() => expect(modeButton()).toBeEnabled());
}

it("hides all directory controls in IndexedDB mode even when directories are mounted", async () => {
  fixture.state.mounts.push(directory);
  await mount();
  expect(modeButton()).toHaveTextContent("storage.browser");
  expect(
    screen.queryByText(directory.name),
  ).not.toBeInTheDocument();
  for (const name of [
    "storage.choose",
    "storage.reconnect",
    "storage.open_cache",
    "storage.open_directory",
  ])
    expect(
      screen.queryByRole("button", { name }),
    ).not.toBeInTheDocument();
  expect(fixture.storage.getVolume).not.toHaveBeenCalled();
});

it("keeps paths out of the method selector and opens the selected desktop root without reconnect controls", async () => {
  fixture.platform.kind = "desktop";
  fixture.platform.filesystem = {
    openDirectory: fixture.openDirectory,
  };
  fixture.state.mounts.push(
    {
      id: "native-default",
      name: "C:\\Default",
      kind: "native",
    },
    directory,
  );
  fixture.state.selected = directory.id;
  await mount();
  expect(modeButton()).toHaveTextContent(
    "storage.local_directory",
  );
  expect(modeButton()).not.toHaveTextContent(
    directory.name,
  );
  expect(
    screen
      .getByText(directory.name)
      .closest("button, input, select"),
  ).toBeNull();
  expect(
    screen.queryByRole("button", {
      name: "storage.reconnect",
    }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", {
      name: "storage.open_directory",
    }),
  );
  expect(fixture.openDirectory).toHaveBeenCalledWith(
    directory.id,
  );
  expect(fixture.openFiles).not.toHaveBeenCalled();
  await chooseMode("storage.browser");
  expect(
    screen.queryByText(directory.name),
  ).not.toBeInTheDocument();
  await chooseMode("storage.local_directory");
  expect(
    fixture.storage.setDefault,
  ).toHaveBeenLastCalledWith(directory.id);
  expect(
    fixture.storage.mountDirectory,
  ).not.toHaveBeenCalled();
  expect(fixture.storage.getVolume).not.toHaveBeenCalled();
});

it("opens the web file cache and only offers reconnect after directory access fails", async () => {
  fixture.state.mounts.push(directory);
  fixture.state.selected = directory.id;
  await mount();
  await waitFor(() =>
    expect(fixture.stat).toHaveBeenCalled(),
  );
  expect(fixture.storage.authorize).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: "storage.reconnect",
    }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", {
      name: "storage.open_cache",
    }),
  );
  expect(fixture.openFiles).toHaveBeenCalledOnce();
  fixture.stat.mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  changed();
  await userEvent.click(
    await screen.findByRole("button", {
      name: "storage.reconnect",
    }),
  );
  expect(fixture.storage.authorize).toHaveBeenCalledWith(
    directory.id,
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", {
        name: "storage.reconnect",
      }),
    ).not.toBeInTheDocument(),
  );
});

it.each(["cancel", "abort"])(
  "keeps IndexedDB active when the initial directory picker returns %s",
  async (result) => {
    if (result === "cancel")
      fixture.storage.mountDirectory.mockResolvedValue(
        null,
      );
    else
      fixture.storage.mountDirectory.mockRejectedValue(
        new DOMException("Cancelled", "AbortError"),
      );
    await mount();
    await chooseMode("storage.local_directory");
    expect(
      fixture.storage.mountDirectory,
    ).toHaveBeenCalledOnce();
    expect(
      fixture.storage.setDefault,
    ).not.toHaveBeenCalled();
    expect(modeButton()).toHaveTextContent(
      "storage.browser",
    );
    expect(
      screen.queryByRole("alert"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "storage.choose",
      }),
    ).not.toBeInTheDocument();
  },
);

it("selects a directory through the picker and updates its read-only location", async () => {
  fixture.storage.mountDirectory.mockImplementation(
    async () => {
      fixture.state.mounts.push(directory);
      changed();
      return directory.id;
    },
  );
  await mount();
  await chooseMode("storage.local_directory");
  expect(fixture.storage.setDefault).toHaveBeenCalledWith(
    directory.id,
  );
  expect(
    screen
      .getByText(directory.name)
      .closest("button, input, select"),
  ).toBeNull();
  const next = {
    ...directory,
    id: "directory-next",
    name: "E:\\Received",
  };
  fixture.storage.mountDirectory.mockImplementation(
    async () => {
      fixture.state.mounts.push(next);
      changed();
      return next.id;
    },
  );
  await userEvent.click(
    screen.getByRole("button", { name: "storage.choose" }),
  );
  await waitFor(() =>
    expect(screen.getByText(next.name)).toBeInTheDocument(),
  );
  expect(
    fixture.storage.setDefault,
  ).toHaveBeenLastCalledWith(next.id);
});

it("disables directory mode when no mounted directory or picker is available", async () => {
  fixture.state.canMount = false;
  await mount();
  await userEvent.click(modeButton());
  expect(
    await screen.findByRole("option", {
      name: "storage.local_directory",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(
    fixture.storage.mountDirectory,
  ).not.toHaveBeenCalled();
});
