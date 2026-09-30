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
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import type {
  CaptureSource,
  NativeCapture,
} from "@weblink/platform";
import { ModalProvider } from "@/components/dialogs/base";
import { createNativeScreenDialog } from "@/components/dialogs/native-screen-dialog";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconCheck: () => <span />,
  IconMonitor: () => <span />,
  IconWindow: () => <span />,
  IconX: () => <span />,
  IconClose: () => <span />,
}));
const sources: CaptureSource[] = [
  {
    id: "screen-1",
    kind: "monitor",
    name: "Display A",
    width: 1920,
    height: 1080,
  },
  {
    id: "window-1",
    kind: "window",
    name: "Editor",
    width: 1200,
    height: 800,
  },
  {
    id: "window-2",
    kind: "window",
    name: "Terminal",
    width: 900,
    height: 600,
  },
];
function mount() {
  const capture: NativeCapture = {
    sources: vi.fn(async () => sources),
    thumbnail: vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    ),
    backends: vi.fn(async () => ({
      screen: [
        { id: "dxgi" as const, name: "DXGI" },
        { id: "wgc" as const, name: "WGC" },
      ],
      window: [{ id: "wgc" as const, name: "WGC" }],
    })),
    start: vi.fn(),
    status: vi.fn(),
    stop: vi.fn(),
  };
  const accepted = vi.fn(),
    cancelled = vi.fn();
  function Owner() {
    const dialog = createNativeScreenDialog(capture);
    return (
      <button
        onClick={() =>
          void dialog.choose().then(accepted, cancelled)
        }
      >
        Open picker
      </button>
    );
  }
  render(() => (
    <ModalProvider>
      <Owner />
    </ModalProvider>
  ));
  fireEvent.click(screen.getByText("Open picker"));
  return { capture, accepted, cancelled };
}
beforeEach(() => {
  // jsdom leaves animationName empty; browsers compute the initial value as none.
  const computedStyle =
    window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation(
    (element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (!style.animationName)
        style.animationName = "none";
      return style;
    },
  );
  setAppState(reconcile(createInitialAppState()));
  let nextImage = 0;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => `blob:thumbnail-${++nextImage}`,
      );
      static revokeObjectURL = vi.fn();
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const share = () =>
  screen.getByRole("button", {
    name: "meeting.native_screen.share",
  });
const tab = (name: string) =>
  fireEvent.click(
    screen.getByRole("tab", {
      name: `meeting.native_screen.${name}`,
    }),
  );

it("defaults audio on, submits the user's choice and resets it when reopened", async () => {
  const { accepted } = mount();
  const audio = () =>
    screen.getByRole("switch", {
      name: "meeting.native_screen.share_audio",
    });
  expect(audio()).toBeChecked();
  fireEvent.click(audio());
  expect(audio()).not.toBeChecked();
  await screen.findByRole("button", { name: /Display A/ });
  tab("windows");
  expect(audio()).not.toBeChecked();
  fireEvent.click(
    screen.getByRole("button", { name: /Editor/ }),
  );
  fireEvent.click(share());
  await waitFor(() =>
    expect(accepted).toHaveBeenCalledWith({
      sourceId: "window-1",
      backend: "auto",
      audio: false,
    }),
  );
  fireEvent.click(screen.getByText("Open picker"));
  expect(audio()).toBeChecked();
});

it("searches windows and uses saved capture settings without offering backend controls", async () => {
  setAppState(
    "options",
    "nativeScreenCaptureBackend",
    "dxgi",
  );
  setAppState(
    "options",
    "nativeWindowCaptureBackend",
    "wgc",
  );
  const { capture, accepted } = mount();
  await screen.findByRole("button", { name: /Display A/ });
  expect(
    screen.queryByRole("button", { name: /Editor/ }),
  ).toBeNull();
  expect(share()).toBeDisabled();
  expect(
    screen.queryByRole("button", {
      name: /meeting.native_screen.screen_backend/,
    }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Display A/ }),
  );
  expect(share()).toBeEnabled();
  tab("windows");
  expect(share()).toBeDisabled();
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: /Display A/ }),
    ).toBeNull(),
  );
  fireEvent.input(screen.getByRole("searchbox"), {
    target: { value: "edit" },
  });
  expect(
    screen.queryByRole("button", { name: /Terminal/ }),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: /Editor/ }),
  );
  expect(
    screen.queryByRole("button", {
      name: /meeting.native_screen.window_backend/,
    }),
  ).toBeNull();
  expect(appState.options.nativeWindowCaptureBackend).toBe(
    "wgc",
  );
  expect(appState.options.nativeScreenCaptureBackend).toBe(
    "dxgi",
  );
  fireEvent.click(share());
  await waitFor(() =>
    expect(accepted).toHaveBeenCalledWith({
      sourceId: "window-1",
      backend: "wgc",
      audio: true,
    }),
  );
  expect(capture.start).not.toHaveBeenCalled();
});

it("reloads sources on each open, clears stale selection and search, and submits saved settings", async () => {
  setAppState(
    "options",
    "nativeScreenCaptureBackend",
    "dxgi",
  );
  const { capture, accepted } = mount();
  await screen.findByRole("button", { name: /Display A/ });
  expect(capture.sources).toHaveBeenCalledTimes(1);
  expect(capture.backends).toHaveBeenCalledTimes(1);
  expect(
    screen.queryByRole("button", {
      name: "meeting.native_screen.refresh",
    }),
  ).toBeNull();
  tab("windows");
  fireEvent.input(screen.getByRole("searchbox"), {
    target: { value: "edit" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: /Editor/ }),
  );
  expect(share()).toBeEnabled();
  // Switching tabs uses the current inventory; reopening reloads it.
  expect(capture.sources).toHaveBeenCalledTimes(1);
  const close = async () => {
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
  };
  await close();

  let loaded!: (sources: CaptureSource[]) => void;
  vi.mocked(capture.sources).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        loaded = resolve;
      }),
  );
  fireEvent.click(screen.getByText("Open picker"));
  expect(capture.sources).toHaveBeenCalledTimes(2);
  expect(capture.backends).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("searchbox")).toHaveValue("");
  expect(
    screen.queryByRole("button", { name: /Editor/ }),
  ).toBeNull();
  expect(share()).toBeDisabled();
  expect(capture.thumbnail).toHaveBeenCalledTimes(1);
  loaded(
    sources.filter((source) => source.kind === "window"),
  );
  await screen.findByRole("button", { name: /Terminal/ });
  expect(
    screen.getByRole("button", { name: /Editor/ }),
  ).toHaveAttribute("aria-pressed", "false");
  expect(share()).toBeDisabled();
  tab("screens");
  expect(
    screen.queryByRole("button", { name: /Display A/ }),
  ).toBeNull();
  await close();

  fireEvent.click(screen.getByText("Open picker"));
  fireEvent.click(
    await screen.findByRole("button", {
      name: /Display A/,
    }),
  );
  expect(capture.sources).toHaveBeenCalledTimes(3);
  expect(capture.backends).toHaveBeenCalledTimes(3);
  fireEvent.click(share());
  await waitFor(() =>
    expect(accepted).toHaveBeenCalledWith({
      sourceId: "screen-1",
      backend: "dxgi",
      audio: true,
    }),
  );
});

it("does not silently substitute an unavailable saved window backend", async () => {
  setAppState(
    "options",
    "nativeWindowCaptureBackend",
    "dxgi",
  );
  mount();
  await screen.findByRole("button", { name: /Display A/ });
  tab("windows");
  fireEvent.click(
    screen.getByRole("button", { name: /Editor/ }),
  );
  expect(share()).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "meeting.native_screen.backend_unavailable",
  );
  expect(appState.options.nativeWindowCaptureBackend).toBe(
    "dxgi",
  );
});

it("waits for selection, shows only the latest thumbnail, and releases images on close", async () => {
  const { capture } = mount();
  await screen.findByRole("button", { name: /Display A/ });
  expect(capture.thumbnail).not.toHaveBeenCalled();
  expect(screen.queryByRole("img")).toBeNull();
  expect(
    screen.getByText(
      "meeting.native_screen.preview_select",
    ),
  ).toBeVisible();
  tab("windows");
  let completeFirst!: (image: Blob) => void;
  vi.mocked(capture.thumbnail).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        completeFirst = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Editor/ }),
  );
  expect(capture.thumbnail).toHaveBeenCalledTimes(1);
  fireEvent.click(
    screen.getByRole("button", { name: /Terminal/ }),
  );
  // Rapid selection changes keep only one native request in flight.
  expect(capture.thumbnail).toHaveBeenCalledTimes(1);
  completeFirst(new Blob(["old"]));
  const image = await screen.findByRole("img", {
    name: "Terminal",
  });
  expect(image).toHaveAttribute("src", "blob:thumbnail-1");
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(capture.thumbnail).toHaveBeenLastCalledWith(
    "window-2",
    { backend: "auto" },
  );
  expect(capture.start).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  await waitFor(() =>
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(
      "blob:thumbnail-1",
    ),
  );
});

it("ignores a thumbnail that finishes after cancellation", async () => {
  const { capture } = mount();
  await screen.findByRole("button", { name: /Display A/ });
  let complete!: (image: Blob) => void;
  vi.mocked(capture.thumbnail).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Display A/ }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).toBeNull(),
  );
  complete(new Blob(["late"]));
  await Promise.resolve();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});

it("allows sharing after a thumbnail failure and can retry the preview", async () => {
  const { capture } = mount();
  await screen.findByRole("button", { name: /Display A/ });
  vi.mocked(capture.thumbnail).mockRejectedValueOnce(
    new Error("No frame"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: /Display A/ }),
  );
  await screen.findByText(
    "meeting.native_screen.preview_failed",
  );
  expect(share()).toBeEnabled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "meeting.native_screen.preview_retry",
    }),
  );
  await screen.findByRole("img", { name: "Display A" });
  expect(capture.thumbnail).toHaveBeenCalledTimes(2);
});
