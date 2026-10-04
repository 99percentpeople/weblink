import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { platform } from "../src/platform";

afterEach(clearMocks);
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
