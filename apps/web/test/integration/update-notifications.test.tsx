// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import type {
  NotificationAction,
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
  vi.clearAllMocks();
});

function setup({
  enabled = true,
  visible = false,
  notifications = true,
  result = available,
  failure = false,
  ready = true,
} = {}) {
  const native = {
    check: failure
      ? vi.fn().mockRejectedValue(new Error("Offline"))
      : vi.fn().mockResolvedValue(result),
    install: vi.fn(),
  };
  const preferences = {
    ...defaultNotificationOptions,
    updates: notifications,
  };
  const show = vi.fn();
  const dismiss = vi.fn();
  const open = vi.fn();
  let action!: (event: NotificationAction) => void;
  const service = new NotificationService(
    {
      capabilities: async () => ({
        permission: "granted",
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
    expect(test.updates.startupUpdate()).toBeDefined(),
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
