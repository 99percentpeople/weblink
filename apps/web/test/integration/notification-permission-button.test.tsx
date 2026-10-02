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
  render as renderWithoutPermissions,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { renderWithPermissions as render } from "../support/render-with-permissions";
import { reconcile } from "solid-js/store";
import { NotificationPermissionButton } from "@/components/app/notification-permission-button";
import NotificationSettings from "@/components/settings/notification-settings";
import { browserNotifications } from "@/libs/platform/browser-notifications";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { toast } from "solid-sonner";

const runtime = vi.hoisted(() => ({ kind: "browser" }));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/platform/runtime", async () => ({
  platform: {
    get kind() {
      return runtime.kind;
    },
    notifications: (
      await import("@/libs/platform/browser-notifications")
    ).browserNotifications,
  },
}));
vi.mock("@/options", () => ({ setAppOptions: vi.fn() }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));

const allow = "setting.notifications.allow";
const requesting = "setting.notifications.requesting";
const browser = {
  permission: "default" as NotificationPermission,
  requestPermission:
    vi.fn<() => Promise<NotificationPermission>>(),
};
const permissionsDescriptor =
  Object.getOwnPropertyDescriptor(navigator, "permissions");

function mockPermissions(
  query: () => Promise<PermissionStatus>,
) {
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    value: { query },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  runtime.kind = "browser";
  browser.permission = "default";
  browser.requestPermission.mockImplementation(
    async () => browser.permission,
  );
  vi.stubGlobal("Notification", browser);
  vi.stubGlobal("isSecureContext", true);
  // Exercise the fallback used when permission observation is unsupported.
  mockPermissions(
    vi
      .fn()
      .mockRejectedValue(
        new TypeError("Unsupported permission"),
      ),
  );
  setAppState(reconcile(createInitialAppState()));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (permissionsDescriptor) {
    Object.defineProperty(
      navigator,
      "permissions",
      permissionsDescriptor,
    );
  } else {
    Reflect.deleteProperty(navigator, "permissions");
  }
});

it.each(["granted", "denied"] as const)(
  "requests only on click and hides after %s",
  async (result) => {
    const pending = deferred<NotificationPermission>();
    browser.requestPermission.mockReturnValue(
      pending.promise,
    );
    render(() => <NotificationPermissionButton />);
    const button = await screen.findByRole("button", {
      name: allow,
    });
    expect(
      browser.requestPermission,
    ).not.toHaveBeenCalled();
    fireEvent.click(button);
    // Called synchronously in the click handler, while user activation is still available.
    expect(
      browser.requestPermission,
    ).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleName(requesting);
    fireEvent.click(button);
    expect(
      browser.requestPermission,
    ).toHaveBeenCalledOnce();
    browser.permission = result;
    pending.resolve(result);
    await waitFor(() =>
      expect(
        screen.queryByRole("button"),
      ).not.toBeInTheDocument(),
    );
  },
);

it.each(["granted", "denied"] as const)(
  "starts hidden when permission is already %s",
  async (permission) => {
    browser.permission = permission;
    const capabilities = vi.spyOn(
      browserNotifications,
      "capabilities",
    );
    render(() => <NotificationPermissionButton />);
    await waitFor(() =>
      expect(capabilities).toHaveResolved(),
    );
    expect(
      screen.queryByRole("button"),
    ).not.toBeInTheDocument();
    expect(
      browser.requestPermission,
    ).not.toHaveBeenCalled();
  },
);

it("does not query native permissions or render a button on desktop", () => {
  runtime.kind = "desktop";
  const capabilities = vi.spyOn(
    browserNotifications,
    "capabilities",
  );
  renderWithoutPermissions(() => (
    <NotificationPermissionButton />
  ));
  expect(
    screen.queryByRole("button"),
  ).not.toBeInTheDocument();
  expect(capabilities).not.toHaveBeenCalled();
});

it("hides when notifications are unavailable", async () => {
  vi.stubGlobal("isSecureContext", false);
  const capabilities = vi.spyOn(
    browserNotifications,
    "capabilities",
  );
  render(() => <NotificationPermissionButton />);
  await waitFor(() =>
    expect(capabilities).toHaveResolved(),
  );
  expect(
    screen.queryByRole("button"),
  ).not.toBeInTheDocument();
});

it("keeps the button usable when the prompt is dismissed or fails", async () => {
  render(() => <NotificationPermissionButton />);
  fireEvent.click(
    await screen.findByRole("button", { name: allow }),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: allow }),
    ).toBeEnabled(),
  );
  browser.requestPermission.mockRejectedValueOnce(
    new Error("Failed"),
  );
  fireEvent.click(
    screen.getByRole("button", { name: allow }),
  );
  await waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "setting.notifications.permission_failed",
    ),
  );
  expect(
    screen.getByRole("button", { name: allow }),
  ).toBeEnabled();
});

it("synchronizes settings permission requests with the header without changing notification preferences", async () => {
  setAppState("options", "notifications", "enabled", false);
  browser.requestPermission.mockImplementation(async () => {
    browser.permission = "granted";
    return "granted";
  });
  render(() => (
    <>
      <header>
        <NotificationPermissionButton />
      </header>
      <NotificationSettings />
    </>
  ));
  const header = screen.getByRole("banner");
  const settings = screen.getByRole("region", {
    name: "app_menu.settings_notifications",
  });
  await within(header).findByRole("button", {
    name: allow,
  });
  fireEvent.click(
    await within(settings).findByRole("button", {
      name: allow,
    }),
  );
  await waitFor(() =>
    expect(
      within(header).queryByRole("button"),
    ).not.toBeInTheDocument(),
  );
  await within(settings).findByText(
    "setting.notifications.permission_granted",
  );
  expect(setAppOptions).not.toHaveBeenCalled();
});

it("shows recovery instructions in settings after denying from the header", async () => {
  browser.requestPermission.mockImplementation(async () => {
    browser.permission = "denied";
    return "denied";
  });
  render(() => (
    <>
      <header>
        <NotificationPermissionButton />
      </header>
      <NotificationSettings />
    </>
  ));
  const header = screen.getByRole("banner");
  fireEvent.click(
    await within(header).findByRole("button", {
      name: allow,
    }),
  );
  await screen.findByText(
    "setting.notifications.browser_blocked",
  );
  expect(
    screen.queryByRole("button", { name: allow }),
  ).not.toBeInTheDocument();
});

it("observes browser permission changes and stops listening on unmount", async () => {
  const permissionStatus =
    new EventTarget() as PermissionStatus;
  mockPermissions(
    vi.fn().mockResolvedValue(permissionStatus),
  );
  const capabilities = vi.spyOn(
    browserNotifications,
    "capabilities",
  );
  const view = render(() => (
    <NotificationPermissionButton />
  ));
  await screen.findByRole("button", { name: allow });
  browser.permission = "denied";
  permissionStatus.dispatchEvent(new Event("change"));
  await waitFor(() =>
    expect(
      screen.queryByRole("button"),
    ).not.toBeInTheDocument(),
  );
  browser.permission = "default";
  permissionStatus.dispatchEvent(new Event("change"));
  await screen.findByRole("button", { name: allow });
  view.unmount();
  capabilities.mockClear();
  permissionStatus.dispatchEvent(new Event("change"));
  fireEvent.focus(window);
  fireEvent(document, new Event("visibilitychange"));
  await browserNotifications.requestPermission();
  expect(capabilities).not.toHaveBeenCalled();
});

it("refreshes on returning to the page when permission observation is unavailable", async () => {
  render(() => <NotificationPermissionButton />);
  await screen.findByRole("button", { name: allow });
  browser.permission = "denied";
  fireEvent.focus(window);
  await waitFor(() =>
    expect(
      screen.queryByRole("button"),
    ).not.toBeInTheDocument(),
  );
  browser.permission = "default";
  fireEvent(document, new Event("visibilitychange"));
  await screen.findByRole("button", { name: allow });
});

it("does not attach a late permission observer after unmount", async () => {
  const pending = deferred<PermissionStatus>();
  mockPermissions(vi.fn().mockReturnValue(pending.promise));
  const view = render(() => (
    <NotificationPermissionButton />
  ));
  await screen.findByRole("button", { name: allow });
  view.unmount();
  const permissionStatus =
    new EventTarget() as PermissionStatus;
  const addListener = vi.spyOn(
    permissionStatus,
    "addEventListener",
  );
  pending.resolve(permissionStatus);
  await pending.promise;
  expect(addListener).not.toHaveBeenCalled();
});

it("reuses application permission state when settings reopen and keeps it current while views are closed", async () => {
  const capabilities = vi.spyOn(
    browserNotifications,
    "capabilities",
  );
  const [open, setOpen] = createSignal(false);
  render(() => (
    <>
      <NotificationPermissionButton />
      <Show when={open()}>
        <NotificationSettings />
      </Show>
    </>
  ));
  await screen.findByRole("button", { name: allow });
  expect(capabilities).toHaveBeenCalledOnce();
  setOpen(true);
  await screen.findByText(
    "setting.notifications.permission_default",
  );
  setOpen(false);
  setOpen(true);
  await screen.findByText(
    "setting.notifications.permission_default",
  );
  expect(capabilities).toHaveBeenCalledOnce();
  setOpen(false);
  browser.permission = "denied";
  fireEvent.focus(window);
  await waitFor(() =>
    expect(
      screen.queryByRole("button"),
    ).not.toBeInTheDocument(),
  );
  expect(capabilities).toHaveBeenCalledTimes(2);
  setOpen(true);
  await screen.findByText(
    "setting.notifications.browser_blocked",
  );
  expect(capabilities).toHaveBeenCalledTimes(2);
});

it("shares a single busy signal and prevents concurrent requests across views", async () => {
  const pending = deferred<NotificationPermission>();
  browser.requestPermission.mockReturnValue(
    pending.promise,
  );
  render(() => (
    <>
      <NotificationPermissionButton />
      <NotificationSettings />
    </>
  ));
  await waitFor(() =>
    expect(
      screen.getAllByRole("button", { name: allow }),
    ).toHaveLength(2),
  );
  const buttons = screen.getAllByRole("button", {
    name: allow,
  });
  fireEvent.click(buttons[0]);
  buttons.forEach((button) =>
    expect(button).toBeDisabled(),
  );
  fireEvent.click(buttons[1]);
  expect(browser.requestPermission).toHaveBeenCalledOnce();
  browser.permission = "granted";
  pending.resolve("granted");
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
  expect(
    screen.queryByRole("button", { name: allow }),
  ).not.toBeInTheDocument();
});
