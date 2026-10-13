import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { NativeUpdateProgress } from "@weblink/platform";
import { nativeUpdates } from "../src/updates";

afterEach(clearMocks);

it("returns the native update result and propagates check failures", async () => {
  const ipc = vi
    .fn()
    .mockResolvedValue({ status: "current" });
  mockIPC(ipc);
  await expect(nativeUpdates.check()).resolves.toEqual({
    status: "current",
  });
  expect(ipc).toHaveBeenCalledWith("updates_check", {});
  ipc.mockRejectedValueOnce(new Error("Offline"));
  await expect(nativeUpdates.check()).rejects.toThrow(
    "Offline",
  );
});

it("binds progress to this install and ignores late events after failure", async () => {
  let channel!: Channel<NativeUpdateProgress>;
  const progress = {
    phase: "downloading" as const,
    downloaded: 40,
    total: 100,
  };
  mockIPC((command, args) => {
    expect(command).toBe("updates_install");
    const request = args as {
      version: string;
      channel: Channel<NativeUpdateProgress>;
    };
    expect(request.version).toBe("1.2.0");
    channel = request.channel;
    channel.onmessage(progress);
    throw new Error("Invalid signature");
  });
  const receive = vi.fn();
  await expect(
    nativeUpdates.install("1.2.0", receive),
  ).rejects.toThrow("Invalid signature");
  expect(receive).toHaveBeenCalledWith(progress);
  channel.onmessage(progress);
  expect(receive).toHaveBeenCalledTimes(1);
});
