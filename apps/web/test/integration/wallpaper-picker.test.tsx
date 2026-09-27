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
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { toast } from "solid-sonner";
import WallpaperPicker from "@/components/settings/wallpaper-picker";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

const cache = vi.hoisted(() => ({
  setInfo: vi.fn<() => Promise<void>>(),
  remove: vi.fn<() => Promise<void>>(),
}));
vi.mock("@/libs/application/cache-service", () => ({
  cacheManager: {
    createCache: async () => cache,
    remove: cache.remove,
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("@/components/icons", () => ({
  IconCheck: () => null,
  IconClose: () => null,
  IconRestartAlt: () => null,
  IconSync: () => null,
  IconUploadFile: () => null,
  IconWallpaper: () => null,
}));
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    backgroundImage: () => undefined,
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});

const label = (key: string) =>
  `setting.appearance.background_image.${key}`;
const chooseImage = () => {
  const file = new File(["image"], "wallpaper.png", {
    type: "image/png",
  });
  fireEvent.change(screen.getByLabelText(label("upload")), {
    target: { files: [file] },
  });
  return file;
};

beforeEach(() => {
  vi.clearAllMocks();
  cache.setInfo.mockResolvedValue();
  cache.remove.mockResolvedValue();
  setAppState("options", {
    backgroundImage: undefined,
    backgroundPreset: undefined,
    backgroundImageOpacity: 0.5,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("replaces a saved image with a preset and restores the default without deleting files", () => {
  setAppState(
    "options",
    "backgroundImage",
    "existing-image",
  );
  render(() => <WallpaperPicker />);
  const dots = screen.getByRole("button", {
    name: label("presets.dots"),
  });
  fireEvent.click(dots);
  expect(appState.options.backgroundPreset).toBe("dots");
  expect(appState.options.backgroundImage).toBeUndefined();
  expect(dots.getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(
    screen.getByRole("button", { name: label("reset") }),
  );
  expect(appState.options.backgroundPreset).toBeUndefined();
  expect(appState.options.backgroundImage).toBeUndefined();
  expect(cache.remove).not.toHaveBeenCalled();
});

it("keeps the preset until the uploaded image has been stored", async () => {
  let finish!: () => void;
  cache.setInfo.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  setAppState("options", "backgroundPreset", "linen");
  render(() => <WallpaperPicker />);
  const file = chooseImage();
  await waitFor(() =>
    expect(cache.setInfo).toHaveBeenCalledWith(
      expect.objectContaining({ file }),
    ),
  );
  expect(appState.options.backgroundPreset).toBe("linen");
  expect(appState.options.backgroundImage).toBeUndefined();
  finish();
  await waitFor(() =>
    expect(appState.options.backgroundImage).toBeTruthy(),
  );
  expect(appState.options.backgroundPreset).toBeUndefined();
});

it("preserves the previous wallpaper and reports a failed image import", async () => {
  cache.setInfo.mockRejectedValue(
    new Error("Storage full"),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setAppState(
    "options",
    "backgroundImage",
    "existing-image",
  );
  render(() => <WallpaperPicker />);
  chooseImage();
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      label("upload_failed"),
    ),
  );
  expect(appState.options.backgroundImage).toBe(
    "existing-image",
  );
  expect(cache.remove).toHaveBeenCalledOnce();
  expect(cache.remove).not.toHaveBeenCalledWith(
    "existing-image",
  );
});
