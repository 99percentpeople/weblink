// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { browserNotifications } from "@/libs/platform/browser-notifications";
import { NotificationService } from "@/libs/application/notifications/notification-service";
import { defaultNotificationOptions } from "@/libs/domain/notification-options";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the notification lifecycle inert on LAN HTTP without randomUUID", async () => {
  vi.stubGlobal("crypto", {
    getRandomValues: crypto.getRandomValues.bind(crypto),
  });
  vi.stubGlobal("isSecureContext", false);
  const notification = vi.fn();
  vi.stubGlobal("Notification", notification);
  const onAction = vi.fn();
  const session =
    await browserNotifications.watch(onAction);
  try {
    expect(
      await browserNotifications.capabilities(),
    ).toEqual({
      permission: "unavailable",
      actions: false,
      reply: false,
    });
    expect(
      await browserNotifications.requestPermission(),
    ).toBe("unavailable");
    await session.show({
      id: "message:lan",
      title: "Message",
      body: "Hello",
      silent: true,
      expiresAt: Date.now() + 60_000,
    });
    expect(notification).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
  } finally {
    await session.close();
  }
});

it("routes a buttonless browser notification click to open once without replaying a foreground toast", async () => {
  const notices: BrowserNotice[] = [];
  class BrowserNotice {
    static permission = "granted";
    static maxActions = 0;
    onclick?: () => void;
    close = vi.fn();
    constructor(
      readonly title: string,
      readonly options: NotificationOptions,
    ) {
      notices.push(this);
    }
  }
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("Notification", BrowserNotice);
  vi.stubGlobal("navigator", {});
  const focus = vi
    .spyOn(window, "focus")
    .mockImplementation(() => {});
  const onError = vi.fn();
  let visible = false;
  const service = new NotificationService(
    browserNotifications,
    () => defaultNotificationOptions,
    () => visible,
    onError,
  );
  const respond = vi.fn(async () => {});
  const present = vi.fn(() => ({ dismiss: vi.fn() }));
  try {
    expect(
      await browserNotifications.capabilities(),
    ).toMatchObject({
      actions: false,
      permission: "granted",
    });
    await service.show({
      category: "controlRequests",
      current: () => true,
      notification: {
        id: "control:browser",
        title: "Control request",
        body: "Peer",
        expiresAt: Date.now() + 60_000,
        actions: [
          { id: "approve", title: "Allow" },
          { id: "decline", title: "Deny" },
        ],
      },
      present,
      respond,
    });
    expect(notices).toHaveLength(1);
    expect(notices[0].options).not.toHaveProperty(
      "actions",
    );
    visible = true;
    service.reconcile();
    notices[0].onclick!();
    notices[0].onclick!();
    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith({
      id: "control:browser",
      action: "open",
    });
    expect(focus).toHaveBeenCalled();
    expect(present).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    service.close();
    await Promise.resolve();
  }
});
