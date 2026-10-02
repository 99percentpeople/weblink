import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { nativeNotifications } from "../src/notifications";
afterEach(clearMocks);
it("scopes notifications to a watcher and ignores late native replies", async () => {
  const ipc = vi.fn();
  mockIPC(ipc);
  const receive = vi.fn();
  const session = await nativeNotifications.watch(receive);
  const args = ipc.mock.calls[0][1];
  const action = {
    id: "notice",
    action: "reply",
    text: "hello",
  };
  args.events.onmessage(action);
  expect(receive).toHaveBeenCalledWith(action);
  const notification = {
    id: "notice",
    title: "Title",
    body: "Body",
    icon: "data:image/png;base64,avatar",
    silent: false,
    expiresAt: Date.now() + 60_000,
  };
  await session.show(notification);
  expect(ipc).toHaveBeenLastCalledWith(
    "notifications_show",
    { watchId: args.watchId, notification },
  );
  await session.dismiss("notice");
  expect(ipc).toHaveBeenLastCalledWith(
    "notifications_dismiss",
    { watchId: args.watchId, id: "notice" },
  );
  await session.close();
  await session.close();
  expect(ipc).toHaveBeenLastCalledWith(
    "notifications_unwatch",
    { watchId: args.watchId },
  );
  args.events.onmessage(action);
  expect(receive).toHaveBeenCalledOnce();
  await expect(session.show(notification)).rejects.toThrow(
    "ended",
  );
});
it("unregisters a watcher if registration fails", async () => {
  const ipc = vi.fn(async (command) => {
    if (command === "notifications_watch")
      throw new Error("failed");
  });
  mockIPC(ipc);
  await expect(
    nativeNotifications.watch(vi.fn()),
  ).rejects.toThrow("failed");
  expect(ipc).toHaveBeenLastCalledWith(
    "notifications_unwatch",
    { watchId: expect.any(String) },
  );
});
