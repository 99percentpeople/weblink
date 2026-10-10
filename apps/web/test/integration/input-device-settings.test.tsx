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
import { createSignal, Show, Suspense } from "solid-js";
import { reconcile } from "solid-js/store";
import type {
  InputDeviceSnapshot,
  RuntimeCapabilities,
} from "@weblink/platform";
import RemoteControlSettings from "@/components/settings/remote-control-settings";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { createAppInputDevices } from "@/libs/state/create-app-input-devices";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});
const query = vi.fn();
const prefix = "setting.remote_control.devices.";
const driver = {
  name: "ViGEmBus",
  installUrl:
    "https://docs.nefarius.at/projects/ViGEm/How-to-Install/",
  maintenance: "retired" as const,
};
const snapshot = (
  availability: "available" | "driverRequired",
): InputDeviceSnapshot => ({
  capabilities: [
    {
      kind: "keyboard",
      availability: "available",
      maxDevices: 1,
    },
    {
      kind: "gamepad",
      availability,
      maxDevices: 4,
      driver,
    },
  ],
  mounted: [],
});
function renderSettings(
  os: RuntimeCapabilities["os"] = "windows",
  enabled = true,
) {
  setAppState("capabilities", "runtime", {
    runtime: enabled ? "desktop" : "browser",
    os,
    version: null,
    nativeScreenCapture: false,
    displayRefreshRates: [],
    remoteInput: enabled,
  });
  return render(() => {
    const inputDevices = createAppInputDevices(
      enabled ? { devices: query } : undefined,
    );
    const [active, setActive] = createSignal(true);
    const state = {
      inputDevices,
      runtimeCapabilities: () =>
        appState.capabilities.runtime,
    } as AppStateContextProps;
    return (
      <AppStateContext.Provider value={state}>
        <button onClick={() => setActive(!active())}>
          Toggle settings
        </button>
        <Suspense fallback={<p>Loading settings</p>}>
          <Show when={active()}>
            <RemoteControlSettings />
          </Show>
        </Suspense>
      </AppStateContext.Provider>
    );
  });
}
const refresh = () =>
  screen.getByRole("button", { name: prefix + "refresh" });
const toggle = () =>
  fireEvent.click(
    screen.getByRole("button", { name: "Toggle settings" }),
  );
beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  query.mockReset();
});
afterEach(cleanup);

it("disables dependent gamepad settings while retaining the user's preferences", () => {
  renderSettings("linux", false);
  const enabled = screen.getByRole("switch", {
    name: "setting.remote_control.gamepad.title",
  });
  const vibration = screen.getByRole("switch", {
    name: "setting.remote_control.gamepad.vibration",
  });
  const strength = screen
    .getAllByRole("slider", {
      name: /setting.remote_control.gamepad.strength/,
    })
    .find(
      (element) => element instanceof HTMLInputElement,
    )!;
  const deadZone = screen
    .getAllByRole("slider", {
      name: /setting.remote_control.gamepad.dead_zone/,
    })
    .find(
      (element) => element instanceof HTMLInputElement,
    )!;
  expect(vibration).toBeChecked();
  fireEvent.click(vibration);
  expect(appState.options.remoteGamepad.vibration).toBe(
    false,
  );
  expect(strength).toBeDisabled();
  fireEvent.click(enabled);
  expect(vibration).toBeDisabled();
  expect(deadZone).toBeDisabled();
  fireEvent.click(enabled);
  expect(vibration).not.toBeChecked();
  expect(vibration).not.toBeDisabled();
  toggle();
  toggle();
  expect(appState.options.remoteGamepad.vibration).toBe(
    false,
  );
});

it("keeps the tab usable during initial discovery and reuses it on reentry", async () => {
  let resolve!: (snapshot: InputDeviceSnapshot) => void;
  query.mockReturnValue(
    new Promise<InputDeviceSnapshot>((done) => {
      resolve = done;
    }),
  );
  renderSettings();
  await waitFor(() => expect(query).toHaveBeenCalledOnce());
  expect(
    screen.queryByText("Loading settings"),
  ).not.toBeInTheDocument();
  const gamepad = screen.getByRole("switch", {
    name: "setting.remote_control.gamepad.title",
  });
  expect(gamepad).toBeVisible();
  const previouslyEnabled =
    appState.options.remoteGamepad.enabled;
  fireEvent.click(gamepad);
  expect(appState.options.remoteGamepad.enabled).toBe(
    !previouslyEnabled,
  );
  expect(refresh()).toBeDisabled();
  toggle();
  toggle();
  expect(
    screen.queryByText("Loading settings"),
  ).not.toBeInTheDocument();
  expect(query).toHaveBeenCalledOnce();
  resolve(snapshot("driverRequired"));
  await screen.findByRole("link");
  await waitFor(() => expect(refresh()).toBeEnabled());
  toggle();
  toggle();
  expect(
    screen.getByText(prefix + "driverRequired"),
  ).toBeVisible();
  expect(
    screen.queryByText(prefix + "checking"),
  ).not.toBeInTheDocument();
  await Promise.resolve();
  expect(query).toHaveBeenCalledOnce();
});
it("offers the official Windows driver guide and refreshes after installation", async () => {
  query
    .mockResolvedValueOnce(snapshot("driverRequired"))
    .mockResolvedValue(snapshot("available"));
  renderSettings();
  const link = await screen.findByRole("link");
  await waitFor(() => expect(refresh()).toBeEnabled());
  expect(link).toHaveAttribute("href", driver.installUrl);
  expect(
    screen.getByText(prefix + "driver_description"),
  ).toBeInTheDocument();
  expect(
    screen.getByText(prefix + "driver_retired"),
  ).toBeInTheDocument();
  fireEvent.click(refresh());
  await waitFor(() =>
    expect(
      screen.queryByRole("link"),
    ).not.toBeInTheDocument(),
  );
  expect(query).toHaveBeenCalledTimes(2);
  expect(
    screen.getAllByText(prefix + "available"),
  ).toHaveLength(2);
});
it("keeps cached results visible during a failed refresh and tab reentry", async () => {
  query.mockResolvedValueOnce(snapshot("driverRequired"));
  renderSettings();
  await screen.findByRole("link");
  await waitFor(() => expect(refresh()).toBeEnabled());
  let reject!: (error: Error) => void;
  query.mockReturnValueOnce(
    new Promise((_, fail) => {
      reject = fail;
    }),
  );
  fireEvent.click(refresh());
  expect(refresh()).toBeDisabled();
  expect(refresh()).toHaveAttribute("aria-busy", "true");
  expect(
    screen.getByText(prefix + "driverRequired"),
  ).toBeVisible();
  toggle();
  toggle();
  expect(
    screen.getByText(prefix + "driverRequired"),
  ).toBeVisible();
  expect(
    screen.queryByText("Loading settings"),
  ).not.toBeInTheDocument();
  await waitFor(() =>
    expect(query).toHaveBeenCalledTimes(2),
  );
  reject(new Error("IPC unavailable"));
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent(prefix + "error");
  expect(
    screen.getByText(prefix + "driverRequired"),
  ).toBeVisible();
  expect(refresh()).not.toBeDisabled();
});
it("keeps initial detection errors recoverable", async () => {
  query
    .mockRejectedValueOnce(new Error("backend unavailable"))
    .mockResolvedValue(snapshot("driverRequired"));
  renderSettings();
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent(prefix + "error");
  fireEvent.click(refresh());
  await screen.findByRole("link");
  expect(
    screen.queryByRole("alert"),
  ).not.toBeInTheDocument();
});
it("does not offer a Windows installer on other platforms", async () => {
  query.mockResolvedValue(snapshot("driverRequired"));
  renderSettings("linux");
  await screen.findByText(prefix + "driverRequired");
  expect(
    screen.queryByRole("link"),
  ).not.toBeInTheDocument();
});
it("does not probe native devices in the browser", () => {
  renderSettings("linux", false);
  expect(query).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: prefix + "refresh",
    }),
  ).not.toBeInTheDocument();
});
