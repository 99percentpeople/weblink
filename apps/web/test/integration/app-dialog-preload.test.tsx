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
import userEvent from "@testing-library/user-event";
import { AccountMenu } from "@/components/app/account-menu";
import { AppDialogsProvider } from "../support/app-dialogs-provider";
import { ModalProvider } from "@/components/dialogs/base";

vi.mock("@/components/app/remote-control-status", () => ({
  RemoteControlStatus: () => null,
}));
vi.mock("@/components/app/system-notifications", () => ({
  SystemNotificationBridge: () => null,
}));

const loaded = vi.hoisted(() => ({
  settings: vi.fn(),
  files: vi.fn(),
}));
const mounted = vi.hoisted(() => ({
  settings: vi.fn(),
  files: vi.fn(),
}));
vi.mock("@/components/settings/settings-content", () => {
  loaded.settings();
  return {
    default: (props: {
      section: string;
      onClose(): void;
    }) => {
      mounted.settings(props.section);
      return (
        <button onClick={props.onClose}>
          Settings ready
        </button>
      );
    },
  };
});
vi.mock("@/components/files/file-manager", () => {
  loaded.files();
  return {
    default: () => {
      mounted.files();
      return <p>Files ready</p>;
    },
  };
});
vi.mock("@/components/app/task-center", () => ({
  createTaskCenterDialog: () => ({ open: vi.fn() }),
}));
vi.mock(
  "@/components/dialogs/create-qrcode-dialog",
  () => ({ createQRCodeDialog: () => ({ open: vi.fn() }) }),
);
vi.mock("@/components/dialogs/join-dialog", () => ({
  joinUrl: () => "https://example.test/",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    profile: { name: "Alice", clientId: "uid_alice" },
    roomStatus: { roomId: null },
  },
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({ tasks: { activeCount: () => 0 } }),
}));

let animationStyle: HTMLStyleElement;
const requestIdle =
  vi.fn<
    (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions,
    ) => number
  >();
const cancelIdle = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  requestIdle.mockReturnValue(1);
  vi.stubGlobal("requestIdleCallback", requestIdle);
  vi.stubGlobal("cancelIdleCallback", cancelIdle);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("preloads all settings on idle without mounting them, reuses them on menu intent, and loads files on demand", async () => {
  const user = userEvent.setup();
  render(() => (
    <ModalProvider>
      <AppDialogsProvider>
        <AccountMenu />
      </AppDialogsProvider>
    </ModalProvider>
  ));
  expect(loaded.settings).not.toHaveBeenCalled();
  expect(loaded.files).not.toHaveBeenCalled();

  requestIdle.mock.calls[0][0]({
    didTimeout: false,
    timeRemaining: () => 50,
  });
  await waitFor(() =>
    expect(loaded.settings).toHaveBeenCalledOnce(),
  );
  expect(mounted.settings).not.toHaveBeenCalled();
  expect(loaded.files).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();

  await user.click(
    screen.getByRole("button", { name: "app_menu.title" }),
  );
  const settings = screen.getByRole("menuitem", {
    name: "common.nav.settings",
  });
  fireEvent.focus(settings);
  await waitFor(() =>
    expect(loaded.settings).toHaveBeenCalledOnce(),
  );
  expect(mounted.settings).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(settings);
  const closeSettings = await screen.findByRole("button", {
    name: "Settings ready",
  });
  expect(mounted.settings).toHaveBeenCalledWith(
    "appearance",
  );
  expect(screen.queryByRole("menu")).toBeNull();
  expect(loaded.settings).toHaveBeenCalledOnce();
  await user.click(closeSettings);
  await waitFor(() =>
    expect(screen.queryByRole("dialog")).toBeNull(),
  );

  await user.click(
    screen.getByRole("button", { name: "app_menu.title" }),
  );
  const files = screen.getByRole("menuitem", {
    name: "cache.title",
  });
  fireEvent.pointerEnter(files);
  fireEvent.pointerDown(files, { pointerType: "touch" });
  await waitFor(() =>
    expect(loaded.files).toHaveBeenCalledOnce(),
  );
  expect(mounted.files).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  await user.click(files);
  expect(
    await screen.findByText("Files ready"),
  ).toBeInTheDocument();
  expect(screen.queryByRole("menu")).toBeNull();
  expect(loaded.files).toHaveBeenCalledOnce();
});

it("cancels scheduled warmup when the dialog provider unmounts", () => {
  const view = render(() => (
    <ModalProvider>
      <AppDialogsProvider />
    </ModalProvider>
  ));
  expect(requestIdle).toHaveBeenCalledOnce();
  expect(cancelIdle).not.toHaveBeenCalled();
  view.unmount();
  expect(cancelIdle).toHaveBeenCalledWith(1);
});
