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
  focused = false,
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
    () => focused,
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
      action: (event: NotificationAction) => action(event),
    };
  });
}

it("waits for startup readiness, then sends toast and a system notification with a safe review action", async () => {
  const test = setup({ ready: false });
  expect(test.native.check).not.toHaveBeenCalled();
  test.setReady(true);
  await waitFor(() =>
    expect(test.show).toHaveBeenCalledTimes(1),
  );
  expect(toast.info).toHaveBeenCalledTimes(1);
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

it.each([{ focused: true }, { notifications: false }])(
  "honors native notification preferences while retaining the app toast: %j",
  async (options) => {
    const test = setup(options);
    await waitFor(() =>
      expect(toast.info).toHaveBeenCalledTimes(1),
    );
    expect(test.show).not.toHaveBeenCalled();
  },
);

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

it("withdraws notifications and makes stale actions harmless after disabling", async () => {
  const test = setup();
  await waitFor(() =>
    expect(test.show).toHaveBeenCalledTimes(1),
  );
  const action = vi.mocked(toast.info).mock.calls[0][1]
    ?.action as { onClick(event: MouseEvent): void };
  test.setEnabled(false);
  await waitFor(() =>
    expect(test.dismiss).toHaveBeenCalledWith(
      "desktop-update:1.2.0",
    ),
  );
  test.action({
    id: "desktop-update:1.2.0",
    action: "open",
  });
  action.onClick(new MouseEvent("click"));
  expect(test.open).not.toHaveBeenCalled();
});
