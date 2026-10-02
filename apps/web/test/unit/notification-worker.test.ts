import { describe, expect, it, vi } from "vitest";
import {
  handleNotificationClick,
  handleNotificationMessage,
} from "@/libs/platform/notification-worker";
describe("notification worker routing", () => {
  function setup(action = "") {
    const client = {
      type: "window",
      focus: vi.fn().mockResolvedValue(undefined),
      postMessage: vi.fn(),
    };
    const clients = {
      get: vi.fn(async () => client),
      matchAll: vi.fn(),
      openWindow: vi.fn(),
    };
    const event = {
      action,
      notification: {
        close: vi.fn(),
        data: {
          type: "weblink-notification",
          owner: "tab-1",
          watchId: "watch-1",
          id: "control:1",
          expiresAt: Date.now() + 60_000,
        },
      },
    };
    const run = () =>
      handleNotificationClick(
        event as unknown as NotificationEvent,
        clients as unknown as Clients,
      );
    return { client, clients, event, run };
  }
  it("only routes to its owner, focusing on open but not approve", async () => {
    for (const action of ["", "approve"]) {
      const x = setup(action);
      await x.run();
      expect(x.clients.get).toHaveBeenCalledWith("tab-1");
      expect(x.client.postMessage).toHaveBeenCalledWith({
        type: "weblink-notification-action",
        watchId: "watch-1",
        id: "control:1",
        action: action || "open",
      });
      expect(x.client.focus).toHaveBeenCalledTimes(
        action ? 0 : 1,
      );
      expect(x.clients.matchAll).not.toHaveBeenCalled();
    }
  });
  it("drops expired or closed-page actions without opening another page", async () => {
    const expired = setup("approve");
    expired.event.notification.data.expiresAt = 0;
    await expired.run();
    expect(expired.clients.get).not.toHaveBeenCalled();
    const closed = setup("approve");
    closed.clients.get.mockResolvedValue(
      undefined as never,
    );
    await closed.run();
    expect(
      closed.client.postMessage,
    ).not.toHaveBeenCalled();
    expect(
      closed.clients.openWindow,
    ).not.toHaveBeenCalled();
  });
});

it("unload cleanup only retracts notifications from the same page and watcher", async () => {
  const notification = (
    owner: string,
    watchId: string,
  ) => ({
    data: { type: "weblink-notification", owner, watchId },
    close: vi.fn(),
  });
  const own = notification("page-1", "watch-1");
  const otherPage = notification("page-2", "watch-1");
  const otherWatch = notification("page-1", "watch-2");
  await handleNotificationMessage(
    {
      source: { id: "page-1" },
      data: {
        type: "weblink-notification-close",
        watchId: "watch-1",
      },
    } as unknown as ExtendableMessageEvent,
    {
      getNotifications: async () => [
        own,
        otherPage,
        otherWatch,
      ],
    } as unknown as ServiceWorkerRegistration,
  );
  expect(own.close).toHaveBeenCalledOnce();
  expect(otherPage.close).not.toHaveBeenCalled();
  expect(otherWatch.close).not.toHaveBeenCalled();
});
