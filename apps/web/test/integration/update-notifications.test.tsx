// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import type {
  NotificationAction,
  NotificationPermissionState,
  NativeUpdateCheck,
} from "@weblink/platform";
import { toast } from "solid-sonner";
import { createAppUpdates } from "@/libs/state/create-app-updates";
import { createUpdateFeedback } from "@/libs/hooks/create-update-feedback";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { info: vi.fn(), dismiss: vi.fn() },
}));
const available: NativeUpdateCheck = {
  status: "available",
  update: {
    version: "1.2.0",
    notes: null,
    canInstall: true,
    downloadKind: "installer",
    downloadUrl: "https://example.com/setup.exe",
  },
};
let dispose: () => void;
afterEach(() => {
  dispose?.();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const HOUR = 60 * 60_000;

function setup({
  enabled = true,
  visible = false,
  notifications = true,
  result = available,
  failure = false,
  ready = true,
  systemNotifications = true,
  permission = "granted" as NotificationPermissionState,
} = {}) {
  const native = {
    check: failure
      ? vi.fn().mockRejectedValue(new Error("Offline"))
      : vi.fn().mockResolvedValue(result),
    install: vi.fn(),
  };
  const preferences = {
    ...defaultNotificationOptions,
    enabled: systemNotifications,
    updates: notifications,
  };
  const show = vi.fn();
  const dismiss = vi.fn();
  const open = vi.fn();
  let action!: (event: NotificationAction) => void;
  const service = new NotificationService(
    {
      capabilities: async () => ({
        permission,
        actions: true,
        reply: false,
      }),
      requestPermission: async () => "granted",
      watch: async (receive) => {
        action = receive;
        return { show, dismiss, close: vi.fn() };
      },
    },
    () => preferences,
    () => visible,
    vi.fn(),
  );
  return createRoot((cleanup) => {
    dispose = () => {
      cleanup();
      service.close();
    };
    const [isEnabled, setEnabled] = createSignal(enabled);
    const [isReady, setReady] = createSignal(ready);
    const updates = createAppUpdates(native);
    createUpdateFeedback({
      updates,
      enabled: isEnabled,
      ready: isReady,
      notifications: service,
      openUpdates: open,
    });
    return {
      native,
      show,
      dismiss,
      open,
      updates,
      setEnabled,
      setReady,
      setVisible: (value: boolean) => {
        visible = value;
        service.reconcile();
      },
      action: (event: NotificationAction) => action(event),
    };
  });
}

it("waits for startup readiness, then sends one background notification with a safe review action", async () => {
  const test = setup({ ready: false });
  expect(test.native.check).not.toHaveBeenCalled();
  test.setReady(true);
  await waitFor(() =>
    expect(test.show).toHaveBeenCalledTimes(1),
  );
  expect(toast.info).not.toHaveBeenCalled();
  test.setVisible(true);
  test.setVisible(false);
  test.setVisible(true);
  expect(toast.info).not.toHaveBeenCalled();
  expect(test.show).toHaveBeenCalledOnce();
  const notification = test.show.mock.calls[0][0];
  expect(notification.id).toBe("desktop-update:1.2.0");
  test.action({ id: notification.id, action: "open" });
  expect(test.open).toHaveBeenCalledTimes(1);
  test.action({ id: notification.id, action: "open" });
  expect(test.open).toHaveBeenCalledTimes(1);
  expect(test.native.install).not.toHaveBeenCalled();
  await test.updates.checkOnStartup(() => true);
  expect(test.native.check).toHaveBeenCalledTimes(1);
});

it.each([
  { visible: true },
  { visible: true, notifications: false },
])(
  "honors native notification preferences while retaining the app toast: %j",
  async (options) => {
    const test = setup(options);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledTimes(1),
    );
    expect(test.show).not.toHaveBeenCalled();
    test.setVisible(false);
    test.setVisible(true);
    expect(test.show).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledOnce();
  },
);

it("presents a pending update once on return when background notifications are disabled", async () => {
  const test = setup({ notifications: false });
  await waitFor(() =>
    expect(test.updates.automaticUpdate()).toBeDefined(),
  );
  expect(test.show).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
  test.setVisible(true);
  test.setVisible(false);
  test.setVisible(true);
  expect(toast.info).toHaveBeenCalledOnce();
  expect(test.show).not.toHaveBeenCalled();
});

it("does not check at startup when disabled", async () => {
  const test = setup({ enabled: false });
  await Promise.resolve();
  expect(test.native.check).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
  test.setEnabled(true);
  await Promise.resolve();
  expect(test.native.check).not.toHaveBeenCalled();
});

it("checks every hour and announces each new version only once", async () => {
  vi.useFakeTimers();
  const test = setup();
  await vi.advanceTimersByTimeAsync(0);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  expect(test.show).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(HOUR - 1);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(test.native.check).toHaveBeenCalledTimes(2);
  expect(test.show).toHaveBeenCalledTimes(1);

  test.native.check.mockResolvedValue({
    ...available,
    update: { ...available.update, version: "1.3.0" },
  });
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(3);
  expect(test.show).toHaveBeenCalledTimes(2);
  expect(test.show.mock.calls[1][0].id).toBe(
    "desktop-update:1.3.0",
  );
  expect(test.native.install).not.toHaveBeenCalled();
});

it("preserves an undelivered update reminder across hourly checks until the app becomes visible", async () => {
  vi.useFakeTimers();
  const test = setup({ notifications: false });
  await vi.advanceTimersByTimeAsync(2 * HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(3);
  expect(test.show).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
  test.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(toast.info).toHaveBeenCalledTimes(1);
});

it.each([
  { notifications: false },
  { systemNotifications: false },
  { permission: "denied" as const },
])(
  "retains a pending foreground reminder after failed hourly checks: %j",
  async (options) => {
    vi.useFakeTimers();
    const test = setup(options);
    await vi.advanceTimersByTimeAsync(0);
    test.native.check.mockRejectedValue(
      new Error("Offline"),
    );
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(test.updates.error()).toBe("check");
    expect(test.updates.update()).toBeUndefined();
    expect(toast.info).not.toHaveBeenCalled();
    expect(test.show).not.toHaveBeenCalled();
    test.setVisible(true);
    expect(toast.info).toHaveBeenCalledOnce();
    const action = vi.mocked(toast.info).mock.calls[0][1]
      ?.action as { onClick(event: MouseEvent): void };
    action.onClick(new MouseEvent("click"));
    expect(test.open).toHaveBeenCalledOnce();
    expect(test.native.install).not.toHaveBeenCalled();

    test.native.check.mockResolvedValue(available);
    await vi.advanceTimersByTimeAsync(HOUR);
    test.setVisible(false);
    test.setVisible(true);
    expect(toast.info).toHaveBeenCalledOnce();
    expect(test.show).not.toHaveBeenCalled();
  },
);

it("retains an undelivered update after a long suspension without waiting for another check", async () => {
  vi.useFakeTimers();
  const test = setup({ notifications: false });
  await vi.advanceTimersByTimeAsync(0);
  // Simulate a sleeping computer: wall time advances without interval callbacks.
  vi.setSystemTime(Date.now() + 48 * HOUR);
  test.setVisible(true);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  expect(toast.info).toHaveBeenCalledOnce();
  test.setVisible(false);
  test.setVisible(true);
  expect(toast.info).toHaveBeenCalledOnce();
});

it.each([
  { status: "current" },
  { status: "unavailable", reason: "development" },
] satisfies NativeUpdateCheck[])(
  "withdraws an undelivered update when a successful check confirms %j",
  async (result) => {
    vi.useFakeTimers();
    const test = setup({ notifications: false });
    await vi.advanceTimersByTimeAsync(0);
    test.native.check.mockResolvedValue(result);
    await test.updates.check();
    test.setVisible(true);
    expect(test.updates.automaticUpdate()).toBeUndefined();
    expect(toast.info).not.toHaveBeenCalled();
  },
);

it("replaces an undelivered update with the latest version before returning to the foreground", async () => {
  vi.useFakeTimers();
  const test = setup({ notifications: false });
  await vi.advanceTimersByTimeAsync(0);
  test.native.check.mockResolvedValue({
    ...available,
    update: { ...available.update, version: "1.3.0" },
  });
  await vi.advanceTimersByTimeAsync(HOUR);
  test.setVisible(true);
  expect(toast.info).toHaveBeenCalledOnce();
  expect(toast.info).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ id: "desktop-update:1.3.0" }),
  );
});

it("stops the timer when disabled or disposed and restarts it when enabled", async () => {
  vi.useFakeTimers();
  const test = setup();
  await vi.advanceTimersByTimeAsync(0);
  test.setEnabled(false);
  await vi.advanceTimersByTimeAsync(2 * HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  await test.updates.check();
  expect(test.native.check).toHaveBeenCalledTimes(2);

  test.setEnabled(true);
  await vi.advanceTimersByTimeAsync(HOUR - 1);
  expect(test.native.check).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(test.native.check).toHaveBeenCalledTimes(3);
  dispose();
  await vi.advanceTimersByTimeAsync(2 * HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(3);
});

it("waits for readiness before starting the hourly schedule without repeating startup checks", async () => {
  vi.useFakeTimers();
  const test = setup({ ready: false });
  await vi.advanceTimersByTimeAsync(2 * HOUR);
  expect(test.native.check).not.toHaveBeenCalled();
  test.setReady(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  test.setReady(false);
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  test.setReady(true);
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(2);
});

it("shares pending checks across timer ticks and manual checks, and suppresses late disabled reminders", async () => {
  vi.useFakeTimers();
  const test = setup({
    result: { status: "current" } as NativeUpdateCheck,
  });
  await vi.advanceTimersByTimeAsync(0);
  let resolve!: (result: NativeUpdateCheck) => void;
  test.native.check.mockImplementationOnce(
    () => new Promise((yes) => (resolve = yes)),
  );
  await vi.advanceTimersByTimeAsync(HOUR);
  const manual = test.updates.check();
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(2);
  test.setEnabled(false);
  resolve(available);
  await manual;
  await vi.advanceTimersByTimeAsync(0);
  expect(test.updates.automaticUpdate()).toBeUndefined();
  expect(test.show).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});

it("skips hourly checks during installation and resumes after an install failure", async () => {
  vi.useFakeTimers();
  const test = setup();
  await vi.advanceTimersByTimeAsync(0);
  let reject!: (error: Error) => void;
  test.native.install.mockImplementationOnce(
    () => new Promise((_, no) => (reject = no)),
  );
  const installation = test.updates.install();
  await vi.advanceTimersByTimeAsync(2 * HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(1);
  reject(new Error("Invalid signature"));
  await installation;
  await vi.advanceTimersByTimeAsync(HOUR);
  expect(test.native.check).toHaveBeenCalledTimes(2);
  expect(test.native.install).toHaveBeenCalledTimes(1);
});

it.each([
  { result: { status: "current" } as NativeUpdateCheck },
  {
    result: {
      status: "unavailable",
      reason: "development",
    } as NativeUpdateCheck,
  },
  { failure: true },
])(
  "keeps background checks quiet without an available update: %j",
  async (options) => {
    const test = setup(options);
    await waitFor(() =>
      expect(test.updates.pending()).toBeNull(),
    );
    expect(test.native.check).toHaveBeenCalledTimes(1);
    expect(toast.info).not.toHaveBeenCalled();
    expect(test.show).not.toHaveBeenCalled();
  },
);

it.each([true, false])(
  "withdraws notifications and makes stale actions harmless after disabling (visible=%s)",
  async (visible) => {
    const test = setup({ visible });
    await waitFor(() =>
      expect(
        visible ? toast.info : test.show,
      ).toHaveBeenCalledOnce(),
    );
    const action = vi.mocked(toast.info).mock.calls[0]?.[1]
      ?.action as
      | { onClick(event: MouseEvent): void }
      | undefined;
    test.setEnabled(false);
    await waitFor(() =>
      expect(
        visible ? toast.dismiss : test.dismiss,
      ).toHaveBeenCalledWith("desktop-update:1.2.0"),
    );
    test.action({
      id: "desktop-update:1.2.0",
      action: "open",
    });
    action?.onClick(new MouseEvent("click"));
    expect(test.open).not.toHaveBeenCalled();
  },
);
