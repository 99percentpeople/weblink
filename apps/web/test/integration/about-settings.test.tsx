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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { toast } from "solid-sonner";
import AboutSettings from "@/components/settings/about-settings";
import { ModalProvider } from "@/components/dialogs/base";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { getDefaultAppOptions } from "@/libs/state/app-options";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  const { getDefaultAppOptions } =
    await import("@/libs/state/app-options");
  return {
    getDefaultAppOptions,
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});

const copy = vi.fn();
const removeCache = vi.fn();
const unregister = vi.fn();
const listCaches = vi.fn();
const registrations = vi.fn();
let animationStyle: HTMLStyleElement;
const button = (name: string) =>
  screen.getByRole("button", { name });
const mount = () =>
  render(() => (
    <ModalProvider>
      <AboutSettings />
    </ModalProvider>
  ));
const openConfirmation = (action: "reset" | "cache") => {
  fireEvent.click(
    button(
      action === "reset"
        ? "setting.about.reset_options"
        : "setting.about.clear_service_worker_cache",
    ),
  );
  return screen.getByRole("dialog", {
    name:
      action === "reset"
        ? "common.reset_options_dialog.title"
        : "common.clear_service_worker_cache_dialog.title",
  });
};
const confirm = (dialog: HTMLElement) =>
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "common.action.confirm",
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  copy.mockResolvedValue(undefined);
  listCaches.mockResolvedValue(["app-shell"]);
  removeCache.mockResolvedValue(true);
  unregister.mockResolvedValue(true);
  registrations.mockResolvedValue([{ unregister }]);
  vi.stubGlobal("__APP_VERSION__", "0.13.0");
  vi.stubGlobal(
    "__APP_BUILD_TIME__",
    Date.UTC(2026, 8, 23, 9),
  );
  vi.stubGlobal("__APP_AUTHOR_NAME__", "99percentpeople");
  vi.stubGlobal(
    "__APP_AUTHOR_URL__",
    "https://github.com/99percentpeople",
  );
  vi.stubGlobal("__APP_LICENSE__", "MIT");
  vi.stubGlobal("caches", {
    keys: listCaches,
    delete: removeCache,
  });
  vi.stubGlobal("navigator", {
    language: "en-US",
    clipboard: { writeText: copy },
    serviceWorker: { getRegistrations: registrations },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  setAppState(reconcile(createInitialAppState()));
  setAppState("options", {
    backgroundImage: "wallpaper",
    backgroundPreset: "linen",
    redirectToClient: "peer",
    clientConfigs: { peer: { provideFileList: false } },
    roomConfigs: {
      room: {
        autoDownloadFiles: true,
        autoDownloadMaxSize: 1024,
      },
    },
  });
  setAppState("message", "conversations", [
    {
      id: "room",
      kind: "room",
      title: "Room",
      roomId: "room",
      namespace: "test",
      labelIds: [],
      createdAt: 1,
    },
  ]);
  setAppState("cache", "cacheInfo", "file", {
    id: "file",
    fileName: "keep.txt",
    fileSize: 12,
    mimetype: "text/plain",
    lastModified: 1,
    chunkSize: 12,
    isComplete: true,
  });
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("shows application info inline and copies the version with an unambiguous build time", async () => {
  mount();
  expect(screen.getByText("0.13.0")).toBeInTheDocument();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(button("setting.about.copy_version"));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      "Weblink 0.13.0\nBuild: 2026-09-23T09:00:00.000Z",
    ),
  );
  expect(toast.success).toHaveBeenCalledWith(
    "common.notification.copy_success",
  );
});

it("reports clipboard denial and lets the user retry", async () => {
  copy.mockRejectedValueOnce(new Error("denied"));
  mount();
  fireEvent.click(button("setting.about.copy_version"));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "setting.about.copy_failed",
    ),
  );
  fireEvent.click(button("setting.about.copy_version"));
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "common.notification.copy_success",
    ),
  );
});

it("only resets after confirmation and removes old optional and per-room values while keeping user data", async () => {
  mount();
  let dialog = openConfirmation("reset");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  await waitFor(() =>
    expect(
      button("setting.about.reset_options"),
    ).toBeEnabled(),
  );
  expect(appState.options.backgroundImage).toBe(
    "wallpaper",
  );
  dialog = openConfirmation("reset");
  confirm(dialog);
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "common.notification.reset_options_success",
    ),
  );
  expect(appState.options).toEqual(getDefaultAppOptions());
  expect(appState.options.backgroundImage).toBeUndefined();
  expect(appState.options.backgroundPreset).toBeUndefined();
  expect(appState.options.redirectToClient).toBeUndefined();
  expect(appState.message.conversations).toHaveLength(1);
  expect(appState.cache.cacheInfo.file.fileName).toBe(
    "keep.txt",
  );
  expect(removeCache).not.toHaveBeenCalled();
});

it("cancels cache cleanup, then clears page resources without reloading or removing preferences and user data", async () => {
  let finish!: (deleted: boolean) => void;
  removeCache.mockReturnValueOnce(
    new Promise<boolean>((resolve) => {
      finish = resolve;
    }),
  );
  mount();
  let dialog = openConfirmation("cache");
  fireEvent.click(
    within(dialog).getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  await waitFor(() =>
    expect(
      button("setting.about.clear_service_worker_cache"),
    ).toBeEnabled(),
  );
  expect(listCaches).not.toHaveBeenCalled();
  dialog = openConfirmation("cache");
  fireEvent.click(within(dialog).getByRole("switch"));
  confirm(dialog);
  await waitFor(() =>
    expect(removeCache).toHaveBeenCalledWith("app-shell"),
  );
  expect(
    button("setting.about.clear_service_worker_cache"),
  ).toBeDisabled();
  expect(
    button("setting.about.reset_options"),
  ).toBeDisabled();
  expect(unregister).not.toHaveBeenCalled();
  finish(true);
  await waitFor(() =>
    expect(toast.success).toHaveBeenCalledWith(
      "common.notification.clear_cache_success",
    ),
  );
  expect(unregister).toHaveBeenCalledOnce();
  expect(
    button("setting.about.clear_service_worker_cache"),
  ).toBeEnabled();
  expect(appState.options.backgroundImage).toBe(
    "wallpaper",
  );
  expect(appState.message.conversations).toHaveLength(1);
  expect(appState.cache.cacheInfo.file.fileName).toBe(
    "keep.txt",
  );
});

it("reports cache cleanup failures and releases the maintenance controls", async () => {
  removeCache.mockRejectedValueOnce(
    new Error("Storage blocked"),
  );
  mount();
  confirm(openConfirmation("cache"));
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "common.notification.clear_cache_failed",
    ),
  );
  expect(toast.success).not.toHaveBeenCalled();
  expect(unregister).not.toHaveBeenCalled();
  expect(
    button("setting.about.clear_service_worker_cache"),
  ).toBeEnabled();
  expect(
    button("setting.about.reset_options"),
  ).toBeEnabled();
});
