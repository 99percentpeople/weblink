import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { platform } from "../src/platform";
import { watchStatus } from "../src/status-watch";

afterEach(clearMocks);
it("aborts a pending registration and unregisters it exactly once after completion", async () => {
  let finish!: () => void;
  const ipc = vi.fn((command: string) =>
    command.endsWith("_watch")
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(),
  );
  mockIPC(ipc);
  const controller = new AbortController();
  const receive = vi.fn();
  const pending = watchStatus(
    "capture",
    { sessionId: "old" },
    receive,
    { signal: controller.signal },
  );
  const args = (
    ipc.mock.calls[0] as unknown as [
      string,
      { events: { onmessage(value: unknown): void } },
    ]
  )[1];
  controller.abort();
  args.events.onmessage({ state: "running" });
  expect(receive).not.toHaveBeenCalled();
  expect(ipc).toHaveBeenCalledTimes(1);
  finish();
  const close = await pending;
  close();
  close();
  expect(ipc).toHaveBeenCalledTimes(2);
  args.events.onmessage({ state: "closed" });
  expect(receive).not.toHaveBeenCalled();
});
it("does not register a watcher for an already disposed scope", async () => {
  const ipc = vi.fn();
  mockIPC(ipc);
  const controller = new AbortController();
  controller.abort();
  (
    await watchStatus("capture", {}, vi.fn(), {
      signal: controller.signal,
    })
  )();
  expect(ipc).not.toHaveBeenCalled();
});
it.each(["capture", "remote_control"])(
  "scopes %s events and idempotent cleanup to one subscription",
  async (command) => {
    const ipc = vi.fn();
    mockIPC(ipc);
    const receive = vi.fn();
    const close =
      command === "capture"
        ? await platform.capture!.watch("owned", receive)
        : await platform.remoteControl!.watch(
            "owned",
            receive,
          );
    const [name, args] = ipc.mock.calls[0];
    expect(name).toBe(`${command}_watch`);
    args.events.onmessage({ state: "running" });
    expect(receive).toHaveBeenCalledOnce();
    close();
    close();
    args.events.onmessage({ state: "closed" });
    expect(receive).toHaveBeenCalledOnce();
    expect(ipc).toHaveBeenCalledTimes(2);
    expect(ipc).toHaveBeenLastCalledWith(
      `${command}_unwatch`,
      {
        [command === "capture" ? "sessionId" : "ownerId"]:
          "owned",
        watchId: args.watchId,
      },
    );
  },
);
it("cleans up a failed registration and suppresses its late events", async () => {
  const ipc = vi.fn(async (command: string) => {
    if (command === "capture_watch")
      throw new Error("failed");
  });
  mockIPC(ipc);
  const receive = vi.fn();
  await expect(
    platform.capture!.watch("owned", receive),
  ).rejects.toThrow("failed");
  const args = (
    ipc.mock.calls[0] as unknown as [string, any]
  )[1];
  args.events.onmessage({ state: "running" });
  expect(receive).not.toHaveBeenCalled();
  expect(ipc).toHaveBeenLastCalledWith("capture_unwatch", {
    sessionId: "owned",
    watchId: args.watchId,
  });
});
