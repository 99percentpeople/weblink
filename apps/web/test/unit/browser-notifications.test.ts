import { afterEach, expect, it, vi } from "vitest";
import { browserNotifications } from "@/libs/platform/browser-notifications";

afterEach(() => vi.unstubAllGlobals());

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
