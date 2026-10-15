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
function setup(native = true) {
  const options = { ...defaultNotificationOptions };
  let visible = false;
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
    native ? platform : undefined,
    () => options,
    () => visible,
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
    visibility: (value: boolean) => {
      visible = value;
      service.reconcile();
    },
  };
}
afterEach(() => vi.useRealTimers());
describe("system notification ownership and policy", () => {
  it.each([true, false])(
    "drops the legacy backgroundOnly=%s preference and validates persisted values",
    (backgroundOnly) => {
      expect(
        resolveNotificationOptions({
          enabled: false,
          backgroundOnly,
          messages: 0,
          preview: false,
        }),
      ).toEqual({
        ...defaultNotificationOptions,
        enabled: false,
        preview: false,
      });
    },
  );
  it.each([
    "messages",
    "controlRequests",
    "speedTestRequests",
    "transfers",
    "updates",
  ] as const)(
    "only displays %s notifications while hidden",
    async (category) => {
      const x = setup();
      x.intent.category = category;
      x.visibility(true);
      await x.service.show(x.intent);
      expect(x.session.show).not.toHaveBeenCalled();
      expect(
        x.platform.capabilities,
      ).not.toHaveBeenCalled();
      x.visibility(false);
      await Promise.resolve();
      expect(x.session.show).not.toHaveBeenCalled();
      await x.service.show(x.intent);
      expect(x.session.show).toHaveBeenCalledOnce();
    },
  );
  it("does not ask for permission implicitly or queue foreground/muted events", async () => {
    const x = setup();
    x.visibility(true);
    await x.service.show(x.intent);
    expect(x.session.show).not.toHaveBeenCalled();
    x.visibility(false);
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
    await x.service.show({
      ...x.intent,
      notification: {
        ...x.intent.notification,
        id: "blocked:2",
      },
    });
    expect(x.session.show).toHaveBeenCalledOnce();
  });
  it("consumes a live request once even if opening makes the app visible", async () => {
    const x = setup();
    await x.service.show(x.intent);
    x.visibility(true);
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
  it.each(["clear", "visible", "stale", "close"])(
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
      if (mode === "visible") x.visibility(true);
      if (mode === "stale")
        vi.mocked(x.intent.current).mockReturnValue(false);
      if (mode === "close") x.service.close();
      finish("data:image/png;base64,avatar");
      await showing;
      expect(x.session.show).not.toHaveBeenCalled();
    },
  );
});

describe("shared toast and system delivery", () => {
  function withToast(native = true) {
    const x = setup(native);
    const presentation = {
      dismiss: vi.fn(),
      update: vi.fn(),
    };
    const present = vi.fn(() => presentation);
    x.intent.present = present;
    return { ...x, present, presentation };
  }

  it("keeps a foreground event on its original channel after visibility and settings changes", async () => {
    const x = withToast();
    x.visibility(true);
    await x.service.show(x.intent);
    x.visibility(false);
    x.options.enabled = false;
    x.service.clear();
    x.options.enabled = true;
    await x.service.show(x.intent);
    x.visibility(true);
    x.service.update(x.intent.notification.id);
    expect(x.present).toHaveBeenCalledOnce();
    expect(x.presentation.update).toHaveBeenCalledOnce();
    expect(x.presentation.dismiss).not.toHaveBeenCalled();
    expect(x.session.show).not.toHaveBeenCalled();
    x.service.dismiss(x.intent.notification.id);
    x.visibility(false);
    await x.service.show(x.intent);
    expect(x.presentation.dismiss).toHaveBeenCalledOnce();
    expect(x.session.show).not.toHaveBeenCalled();
    expect(x.present).toHaveBeenCalledOnce();
  });

  it("never replays a system event as a toast, including after it was consumed", async () => {
    const x = withToast();
    await x.service.show(x.intent);
    x.visibility(true);
    await x.service.show(x.intent);
    x.action({
      id: x.intent.notification.id,
      action: "open",
    });
    x.visibility(false);
    x.visibility(true);
    await x.service.show(x.intent);
    expect(x.intent.respond).toHaveBeenCalledOnce();
    expect(x.session.show).toHaveBeenCalledOnce();
    expect(x.present).not.toHaveBeenCalled();
  });

  it.each(["permission", "icon"])(
    "cancels %s preparation when a foreground toast wins",
    async (stage) => {
      const x = withToast();
      let finish!: () => void;
      if (stage === "permission")
        vi.mocked(
          x.platform.capabilities,
        ).mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = () =>
                resolve({
                  permission: "granted",
                  actions: true,
                  reply: false,
                });
            }),
        );
      else
        x.intent.prepareIcon = vi.fn(
          () =>
            new Promise<string>((resolve) => {
              finish = () => resolve("avatar");
            }),
        );
      const showing = x.service.show(x.intent);
      await vi.waitFor(() =>
        expect(finish).toBeTypeOf("function"),
      );
      x.visibility(true);
      expect(x.present).toHaveBeenCalledOnce();
      x.visibility(false);
      finish();
      await showing;
      await x.service.show(x.intent);
      expect(x.session.show).not.toHaveBeenCalled();
      expect(x.present).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "waits for a racing native dispatch before deciding a foreground fallback (success=%s)",
    async (success) => {
      const x = withToast();
      let finish!: () => void;
      x.session.show.mockImplementation(
        () =>
          new Promise<void>((resolve, reject) => {
            finish = () =>
              success
                ? resolve()
                : reject(new Error("unavailable"));
          }),
      );
      const showing = x.service.show(x.intent);
      await vi.waitFor(() =>
        expect(x.session.show).toHaveBeenCalledOnce(),
      );
      x.visibility(true);
      await x.service.show(x.intent);
      expect(x.present).not.toHaveBeenCalled();
      finish();
      await showing;
      expect(x.present).toHaveBeenCalledTimes(
        success ? 0 : 1,
      );
      x.visibility(false);
      x.visibility(true);
      await x.service.show(x.intent);
      expect(x.session.show).toHaveBeenCalledOnce();
      expect(x.present).toHaveBeenCalledTimes(
        success ? 0 : 1,
      );
    },
  );

  it("does not replay a delivered event if retracting it fails", async () => {
    const x = withToast();
    x.session.show.mockImplementation(async () => {
      x.visibility(true);
    });
    x.session.dismiss.mockRejectedValue(
      new Error("cannot retract"),
    );
    await x.service.show(x.intent);
    x.service.reconcile();
    expect(x.onError).toHaveBeenCalledOnce();
    expect(x.present).not.toHaveBeenCalled();
  });

  it("retracts a failed native dispatch before showing its foreground fallback", async () => {
    const x = withToast();
    let finish!: () => void;
    x.session.show.mockRejectedValue(
      new Error("failed dispatch"),
    );
    x.session.dismiss.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const showing = x.service.show(x.intent);
    await vi.waitFor(() =>
      expect(x.session.dismiss).toHaveBeenCalledWith(
        x.intent.notification.id,
      ),
    );
    x.visibility(true);
    x.action({
      id: x.intent.notification.id,
      action: "approve",
    });
    expect(x.intent.respond).not.toHaveBeenCalled();
    expect(x.present).not.toHaveBeenCalled();
    finish();
    await showing;
    expect(x.present).toHaveBeenCalledOnce();
  });

  it.each([
    "no-adapter",
    "disabled",
    "category",
    "denied",
    "failure",
  ])(
    "keeps an undelivered request actionable in the foreground when %s",
    async (mode) => {
      const x = withToast(mode !== "no-adapter");
      if (mode === "disabled") x.options.enabled = false;
      if (mode === "category")
        x.options.controlRequests = false;
      if (mode === "denied")
        vi.mocked(
          x.platform.capabilities,
        ).mockResolvedValue({
          permission: "denied",
          actions: false,
          reply: false,
        });
      if (mode === "failure")
        x.session.show.mockRejectedValue(
          new Error("unavailable"),
        );
      await x.service.show(x.intent);
      expect(x.present).not.toHaveBeenCalled();
      x.visibility(true);
      x.service.reconcile();
      expect(x.present).toHaveBeenCalledOnce();
      expect(
        x.platform.requestPermission,
      ).not.toHaveBeenCalled();
    },
  );

  it.each(["expired", "stale", "closed"])(
    "never presents an undelivered request that is %s",
    async (reason) => {
      const x = withToast(false);
      await x.service.show(x.intent);
      if (reason === "expired")
        x.intent.notification.expiresAt = Date.now() - 1;
      if (reason === "stale")
        vi.mocked(x.intent.current).mockReturnValue(false);
      if (reason === "closed") x.service.close();
      x.visibility(true);
      expect(x.present).not.toHaveBeenCalled();
    },
  );

  it("retains opted-in foreground feedback beyond native expiry without sending an expired system notification", async () => {
    vi.useFakeTimers();
    const x = withToast();
    x.intent.retainInApp = true;
    x.options.enabled = false;
    await x.service.show(x.intent);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    x.service.reconcile();
    x.options.enabled = true;
    await x.service.show(x.intent);
    expect(x.session.show).not.toHaveBeenCalled();
    x.visibility(true);
    x.service.reconcile();
    x.service.update(x.intent.notification.id);
    expect(x.present).toHaveBeenCalledOnce();
    expect(x.presentation.update).toHaveBeenCalledOnce();
    expect(x.presentation.dismiss).not.toHaveBeenCalled();
    x.visibility(false);
    x.visibility(true);
    expect(x.present).toHaveBeenCalledOnce();
    vi.mocked(x.intent.current).mockReturnValue(false);
    x.service.reconcile();
    expect(x.presentation.dismiss).toHaveBeenCalledOnce();
  });

  it.each(["stale", "closed", "dismissed", "delivered"])(
    "does not replay retained feedback that is %s after native expiry",
    async (reason) => {
      vi.useFakeTimers();
      const x = withToast();
      x.intent.retainInApp = true;
      x.options.enabled = reason === "delivered";
      await x.service.show(x.intent);
      if (reason === "stale")
        vi.mocked(x.intent.current).mockReturnValue(false);
      if (reason === "closed") x.service.close();
      if (reason === "dismissed")
        x.service.dismiss(x.intent.notification.id);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      x.visibility(true);
      expect(x.present).not.toHaveBeenCalled();
    },
  );

  it("deduplicates by event ID without suppressing a different event with identical text", async () => {
    const x = withToast();
    x.visibility(true);
    await x.service.show(x.intent);
    await x.service.show({
      ...x.intent,
      notification: { ...x.intent.notification },
    });
    await x.service.show({
      ...x.intent,
      notification: {
        ...x.intent.notification,
        id: "control:2",
      },
    });
    expect(x.present).toHaveBeenCalledTimes(2);
    expect(x.session.show).not.toHaveBeenCalled();
  });
});
