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
import { createSignal, Show } from "solid-js";
import type { NativeAutostartStatus } from "@weblink/platform";
import ApplicationSettings from "@/components/settings/application-settings";
import RemoteKeyboardSettings from "@/components/settings/remote-keyboard-settings";
import { SettingsStateProvider } from "../helpers/settings-state";

const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  status: vi.fn(),
  behavior: vi.fn(),
  setEnabled: vi.fn(),
  setBehavior: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/options", () => ({ setAppOptions: vi.fn() }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    kind: "desktop",
    keyboard: {},
    application: { autostart: api },
    getCapabilities: api.capabilities,
  },
}));
beforeEach(() => {
  vi.resetAllMocks();
  api.capabilities.mockResolvedValue({
    runtime: "desktop",
    os: "windows",
    version: null,
    nativeScreenCapture: false,
    displayRefreshRates: [],
    remoteInput: true,
    systemKeyboard: true,
    systemTray: true,
  });
  api.status.mockResolvedValue({
    enabled: true,
    pathMismatch: false,
  });
  api.behavior.mockResolvedValue("window");
  api.setEnabled.mockResolvedValue({
    enabled: false,
    pathMismatch: false,
  });
  api.setBehavior.mockResolvedValue(undefined);
});
afterEach(cleanup);

const autostart = () =>
  screen.getByRole("switch", {
    name: "setting.application.autostart",
  });

it("preloads before settings open and immediately reuses startup and runtime capabilities on reopening", async () => {
  const [open, setOpen] = createSignal(false);
  render(() => (
    <SettingsStateProvider>
      <Show when={open()}>
        <ApplicationSettings />
        <RemoteKeyboardSettings />
      </Show>
    </SettingsStateProvider>
  ));
  await waitFor(() =>
    expect(api.status).toHaveBeenCalledOnce(),
  );
  setOpen(true);
  expect(autostart()).toBeChecked();
  expect(autostart()).toBeEnabled();
  expect(
    screen.getByRole("switch", {
      name: "setting.application.auto_hide.title",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("switch", {
      name: "setting.remote_control.system_keyboard.title",
    }),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: /setting.application.startup_behavior.title/,
    }),
  ).toHaveTextContent(
    "setting.application.startup_behavior.window",
  );
  setOpen(false);
  setOpen(true);
  expect(autostart()).toBeChecked();
  expect(autostart()).toBeEnabled();
  expect(
    screen.getByRole("switch", {
      name: "setting.remote_control.system_keyboard.title",
    }),
  ).toBeVisible();
  await Promise.resolve();
  expect(api.capabilities).toHaveBeenCalledOnce();
  expect(api.status).toHaveBeenCalledOnce();
  expect(api.behavior).toHaveBeenCalledOnce();
});

it("keeps an in-flight startup write and its result across settings unmounts", async () => {
  let finish!: (value: NativeAutostartStatus) => void;
  api.setEnabled.mockReturnValue(
    new Promise<NativeAutostartStatus>((resolve) => {
      finish = resolve;
    }),
  );
  const [open, setOpen] = createSignal(true);
  render(() => (
    <SettingsStateProvider>
      <Show when={open()}>
        <ApplicationSettings />
      </Show>
    </SettingsStateProvider>
  ));
  await waitFor(() => expect(autostart()).toBeEnabled());
  fireEvent.click(autostart());
  expect(api.setEnabled).toHaveBeenCalledWith(false);
  setOpen(false);
  setOpen(true);
  expect(autostart()).toBeDisabled();
  finish({ enabled: false, pathMismatch: false });
  await waitFor(() => expect(autostart()).toBeEnabled());
  expect(autostart()).not.toBeChecked();
  setOpen(false);
  setOpen(true);
  expect(autostart()).not.toBeChecked();
  expect(api.status).toHaveBeenCalledOnce();
});

it("disables a mismatched startup entry until the user repairs it and retains the repair across reopening", async () => {
  api.status.mockResolvedValue({
    enabled: true,
    pathMismatch: true,
  });
  let finish!: (value: NativeAutostartStatus) => void;
  api.setEnabled.mockReturnValue(
    new Promise<NativeAutostartStatus>((resolve) => {
      finish = resolve;
    }),
  );
  const [open, setOpen] = createSignal(false);
  render(() => (
    <SettingsStateProvider>
      <Show when={open()}>
        <ApplicationSettings />
      </Show>
    </SettingsStateProvider>
  ));
  await waitFor(() =>
    expect(api.status).toHaveBeenCalledOnce(),
  );
  setOpen(true);
  expect(autostart()).not.toBeChecked();
  expect(autostart()).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent(
    "setting.application.autostart_path_mismatch",
  );
  expect(api.setEnabled).not.toHaveBeenCalled();
  const repair = () =>
    screen.getByRole("button", {
      name: "setting.application.autostart_repair",
    });
  fireEvent.click(repair());
  expect(api.setEnabled).toHaveBeenCalledOnce();
  expect(api.setEnabled).toHaveBeenCalledWith(true);
  expect(repair()).toBeDisabled();
  setOpen(false);
  setOpen(true);
  expect(autostart()).toBeDisabled();
  expect(repair()).toBeDisabled();
  finish({ enabled: true, pathMismatch: false });
  await waitFor(() => expect(autostart()).toBeEnabled());
  expect(autostart()).toBeChecked();
  expect(
    screen.queryByRole("button", {
      name: "setting.application.autostart_repair",
    }),
  ).not.toBeInTheDocument();
});

it("keeps the repair button available after a failed repair", async () => {
  api.status.mockResolvedValue({
    enabled: false,
    pathMismatch: true,
  });
  api.setEnabled.mockRejectedValueOnce(
    new Error("Access denied"),
  );
  render(() => (
    <SettingsStateProvider>
      <ApplicationSettings />
    </SettingsStateProvider>
  ));
  const repair = await screen.findByRole("button", {
    name: "setting.application.autostart_repair",
  });
  fireEvent.click(repair);
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "setting.application.autostart_failed",
    ),
  );
  expect(repair).toBeEnabled();
  expect(autostart()).toBeDisabled();
  expect(autostart()).not.toBeChecked();
});

it("allows enabling startup normally when no entry exists", async () => {
  api.status.mockResolvedValue({
    enabled: false,
    pathMismatch: false,
  });
  api.setEnabled.mockResolvedValue({
    enabled: true,
    pathMismatch: false,
  });
  render(() => (
    <SettingsStateProvider>
      <ApplicationSettings />
    </SettingsStateProvider>
  ));
  await waitFor(() => expect(autostart()).toBeEnabled());
  expect(autostart()).not.toBeChecked();
  expect(
    screen.queryByRole("button", {
      name: "setting.application.autostart_repair",
    }),
  ).not.toBeInTheDocument();
  fireEvent.click(autostart());
  await waitFor(() => expect(autostart()).toBeChecked());
  expect(api.setEnabled).toHaveBeenCalledOnce();
  expect(api.setEnabled).toHaveBeenCalledWith(true);
});
