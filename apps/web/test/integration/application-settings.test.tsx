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
import ApplicationSettings from "@/components/settings/application-settings";
import RemoteKeyboardSettings from "@/components/settings/remote-keyboard-settings";
import { SettingsStateProvider } from "../helpers/settings-state";

const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  enabled: vi.fn(),
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
  api.enabled.mockResolvedValue(true);
  api.behavior.mockResolvedValue("window");
  api.setEnabled.mockResolvedValue(false);
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
    expect(api.enabled).toHaveBeenCalledOnce(),
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
  expect(api.enabled).toHaveBeenCalledOnce();
  expect(api.behavior).toHaveBeenCalledOnce();
});

it("keeps an in-flight startup write and its result across settings unmounts", async () => {
  let finish!: (value: boolean) => void;
  api.setEnabled.mockReturnValue(
    new Promise<boolean>((resolve) => {
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
  finish(false);
  await waitFor(() => expect(autostart()).toBeEnabled());
  expect(autostart()).not.toBeChecked();
  setOpen(false);
  setOpen(true);
  expect(autostart()).not.toBeChecked();
  expect(api.enabled).toHaveBeenCalledOnce();
});
