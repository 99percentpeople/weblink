import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  NotificationService,
  type NotificationIntent,
} from "@/libs/application/notifications/notification-service";
import {
  defaultNotificationOptions,
  resolveNotificationOptions,
} from "@/libs/domain/notification-options";
import type {
  NotificationAction,
  NotificationSession,
  SystemNotifications,
} from "@weblink/platform";
function setup() {
  const options = { ...defaultNotificationOptions };
  let focused = false;
  let action!: (action: NotificationAction) => void;
  const session = {
    show: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  } satisfies NotificationSession;
  const platform: SystemNotifications = {
    capabilities: vi.fn().mockResolvedValue({
      permission: "granted",
      actions: true,
      reply: true,
    }),
    requestPermission: vi.fn(),
    watch: vi.fn(async (receive) => {
      action = receive;
      return session;
    }),
  };
  const onError = vi.fn();
  const service = new NotificationService(
    platform,
    () => options,
    () => focused,
    onError,
  );
  const intent: NotificationIntent = {
    category: "controlRequests",
    current: vi.fn(() => true),
    notification: {
      id: "control:1",
      title: "Request",
      body: "Peer",
      expiresAt: Date.now() + 60_000,
      actions: [
        { id: "approve", title: "Allow" },
        { id: "decline", title: "Deny" },
      ],
    },
    respond: vi.fn().mockResolvedValue(undefined),
  };
  return {
    options,
    session,
    platform,
    service,
    intent,
    onError,
    action: (value: NotificationAction) => action(value),
    focus: () => {
      focused = true;
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("system notification ownership and policy", () => {
  it("defaults to background-only categories and validates persisted values", () => {
    expect(
      resolveNotificationOptions({
        enabled: false,
        backgroundOnly: "false",
        messages: 0,
        preview: false,
      }),
    ).toEqual({
      ...defaultNotificationOptions,
      enabled: false,
      preview: false,
    });
    expect(defaultNotificationOptions.backgroundOnly).toBe(
      true,
    );
  });
  it("does not ask for permission implicitly or queue foreground/muted events", async () => {
    const x = setup();
    x.focus();
    await x.service.show(x.intent);
    expect(x.session.show).not.toHaveBeenCalled();
    x.options.backgroundOnly = false;
    x.options.controlRequests = false;
    await x.service.show(x.intent);
    expect(x.session.show).not.toHaveBeenCalled();
    x.options.controlRequests = true;
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "default",
      actions: false,
      reply: false,
    });
    await x.service.show(x.intent);
    expect(x.session.show).not.toHaveBeenCalled();
    expect(
      x.platform.requestPermission,
    ).not.toHaveBeenCalled();
  });
  it("dispatches a real native event with unknown OS status while still respecting an explicit block", async () => {
    const x = setup();
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "unknown",
      actions: true,
      reply: true,
    });
    await x.service.show(x.intent);
    expect(x.session.show).toHaveBeenCalledOnce();
    expect(
      x.platform.requestPermission,
    ).not.toHaveBeenCalled();
    x.service.dismiss(x.intent.notification.id);
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "denied",
      actions: true,
      reply: true,
    });
    await x.service.show(x.intent);
    expect(x.session.show).toHaveBeenCalledOnce();
  });
  it("consumes a live request once even if opening focuses the app", async () => {
    const x = setup();
    await x.service.show(x.intent);
    x.focus();
    x.service.reconcile();
    x.action({ id: "control:1", action: "approve" });
    x.action({ id: "control:1", action: "approve" });
    expect(x.intent.respond).toHaveBeenCalledOnce();
  });
  it("rejects unknown, stale, disabled, and expired actions", async () => {
    for (const mode of [
      "stale",
      "disabled",
      "expired",
      "unknown",
    ]) {
      const x = setup();
      await x.service.show(x.intent);
      if (mode === "stale")
        vi.mocked(x.intent.current).mockReturnValue(false);
      if (mode === "disabled") x.options.enabled = false;
      if (mode === "expired")
        x.intent.notification.expiresAt = Date.now() - 1;
      x.action({
        id: "control:1",
        action: mode === "unknown" ? "reply" : "approve",
        text: "text",
      });
      expect(x.intent.respond).not.toHaveBeenCalled();
    }
  });
  it("cancels a pending display and dismisses after a racing OS call", async () => {
    const x = setup();
    let finish!: () => void;
    x.session.show.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const show = x.service.show(x.intent);
    await vi.waitFor(() =>
      expect(x.session.show).toHaveBeenCalledOnce(),
    );
    x.service.dismiss(x.intent.notification.id);
    finish();
    await show;
    expect(x.session.dismiss).toHaveBeenCalledWith(
      x.intent.notification.id,
    );
    x.action({ id: "control:1", action: "approve" });
    expect(x.intent.respond).not.toHaveBeenCalled();
  });
  it("deduplicates, strips unsupported actions, honors silent, and closes late watchers", async () => {
    const x = setup();
    x.options.sound = false;
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "granted",
      actions: false,
      reply: false,
    });
    await Promise.all([
      x.service.show(x.intent),
      x.service.show(x.intent),
    ]);
    expect(x.session.show).toHaveBeenCalledOnce();
    expect(x.session.show.mock.calls[0][0]).toMatchObject({
      silent: true,
      actions: undefined,
      reply: undefined,
    });
    x.service.close();
    await Promise.resolve();
    expect(x.session.close).toHaveBeenCalledOnce();
    x.action({ id: "control:1", action: "approve" });
    expect(x.intent.respond).not.toHaveBeenCalled();
  });
  it("never retries a reply callback after failure", async () => {
    const x = setup();
    x.intent.notification.reply = {
      title: "Send",
      placeholder: "Reply",
    };
    vi.mocked(x.intent.respond).mockRejectedValue(
      new Error("offline"),
    );
    await x.service.show(x.intent);
    x.action({
      id: "control:1",
      action: "reply",
      text: "reply",
    });
    await Promise.resolve();
    x.action({
      id: "control:1",
      action: "reply",
      text: "reply",
    });
    expect(x.intent.respond).toHaveBeenCalledOnce();
    expect(x.onError).toHaveBeenCalledOnce();
  });
  it("prepares avatars only for permitted notifications and forwards the image", async () => {
    const x = setup();
    x.intent.prepareIcon = vi
      .fn()
      .mockResolvedValue("data:image/png;base64,avatar");
    x.options.enabled = false;
    await x.service.show(x.intent);
    expect(x.intent.prepareIcon).not.toHaveBeenCalled();
    x.options.enabled = true;
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "denied",
      actions: false,
      reply: false,
    });
    await x.service.show(x.intent);
    expect(x.intent.prepareIcon).not.toHaveBeenCalled();
    vi.mocked(x.platform.capabilities).mockResolvedValue({
      permission: "granted",
      actions: true,
      reply: true,
    });
    await x.service.show(x.intent);
    expect(x.session.show).toHaveBeenCalledWith(
      expect.objectContaining({
        icon: "data:image/png;base64,avatar",
      }),
    );
  });
  it.each(["clear", "focus", "stale", "close"])(
    "does not display after %s while preparing an avatar",
    async (mode) => {
      const x = setup();
      let finish!: (icon: string) => void;
      x.intent.prepareIcon = vi.fn(
        () =>
          new Promise<string | undefined>((resolve) => {
            finish = resolve;
          }),
      );
      const showing = x.service.show(x.intent);
      await vi.waitFor(() =>
        expect(x.intent.prepareIcon).toHaveBeenCalledOnce(),
      );
      if (mode === "clear") x.service.clear();
      if (mode === "focus") x.focus();
      if (mode === "stale")
        vi.mocked(x.intent.current).mockReturnValue(false);
      if (mode === "close") x.service.close();
      finish("data:image/png;base64,avatar");
      await showing;
      expect(x.session.show).not.toHaveBeenCalled();
    },
  );
});
