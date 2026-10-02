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
import type { NotificationCapabilities } from "@weblink/platform";
import NotificationSettings from "@/components/settings/notification-settings";
import { setAppOptions } from "@/options";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
const api = vi.hoisted(() => ({
  capabilities: vi.fn(),
  requestPermission: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: { kind: "desktop", notifications: api },
}));
vi.mock("@/options", () => ({ setAppOptions: vi.fn() }));
const granted: NotificationCapabilities = {
  permission: "granted",
  actions: true,
  reply: true,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  setAppState(reconcile(createInitialAppState()));
  api.capabilities.mockResolvedValue(granted);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("shows loading rather than unavailable while native capabilities are pending", async () => {
  const pending = deferred<NotificationCapabilities>();
  api.capabilities.mockReturnValue(pending.promise);
  render(() => <NotificationSettings />);
  expect(screen.getByRole("status")).toHaveTextContent(
    "setting.notifications.loading",
  );
  expect(
    screen.queryByText(
      "setting.notifications.permission_unavailable",
    ),
  ).not.toBeInTheDocument();
  pending.resolve(granted);
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
});
it("keeps native errors distinct from unsupported and allows retry", async () => {
  api.capabilities.mockRejectedValueOnce(
    "Could not read Windows notification settings: 0x80070490",
  );
  render(() => <NotificationSettings />);
  await screen.findByText(
    "setting.notifications.load_failed",
  );
  expect(
    screen.getByText(/0x80070490/),
  ).toBeInTheDocument();
  expect(
    screen.queryByText(
      "setting.notifications.permission_unavailable",
    ),
  ).not.toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.notifications.retry",
    }),
  );
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
  expect(api.capabilities).toHaveBeenCalledTimes(2);
  expect(api.requestPermission).not.toHaveBeenCalled();
});
it("only shows unavailable when the adapter explicitly reports it", async () => {
  api.capabilities.mockResolvedValue({
    ...granted,
    permission: "unavailable",
  });
  render(() => <NotificationSettings />);
  await screen.findByText(
    "setting.notifications.permission_unavailable",
  );
  expect(
    screen.queryByRole("button", {
      name: "setting.notifications.retry",
    }),
  ).not.toBeInTheDocument();
});
it("does not let an older query overwrite a newer focus refresh", async () => {
  const old = deferred<NotificationCapabilities>();
  api.capabilities.mockReturnValueOnce(old.promise);
  render(() => <NotificationSettings />);
  fireEvent.focus(window);
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
  old.resolve({ ...granted, permission: "denied" });
  await Promise.resolve();
  expect(screen.getByRole("status")).toHaveTextContent(
    "setting.notifications.permission_granted",
  );
});
it("releases its focus listener when settings are closed", async () => {
  const view = render(() => <NotificationSettings />);
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
  view.unmount();
  fireEvent.focus(window);
  await waitFor(() =>
    expect(api.capabilities).toHaveBeenCalledOnce(),
  );
});

it("shows unknown native status without an unnecessary permission prompt", async () => {
  api.capabilities.mockResolvedValue({
    ...granted,
    permission: "unknown",
  });
  render(() => <NotificationSettings />);
  await screen.findByText(
    "setting.notifications.permission_unknown",
  );
  expect(
    screen.queryByRole("button", {
      name: "setting.notifications.allow",
    }),
  ).not.toBeInTheDocument();
  expect(api.requestPermission).not.toHaveBeenCalled();
});

it("provides an independent switch for speed-test requests", async () => {
  render(() => <NotificationSettings />);
  await screen.findByText(
    "setting.notifications.permission_granted",
  );
  const toggle = screen.getByRole("switch", {
    name: "setting.notifications.speedTestRequests",
  });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(setAppOptions).toHaveBeenCalledWith(
    "notifications",
    "speedTestRequests",
    false,
  );
  expect(
    screen.getByRole("switch", {
      name: "setting.notifications.controlRequests",
    }),
  ).toBeChecked();
});
