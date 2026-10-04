import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import type { Channel } from "@tauri-apps/api/core";
import type { NativePipState } from "@weblink/platform";
import { nativePictureInPicture } from "../src/picture-in-picture";
import { nativeApplication } from "../src/application";

afterEach(clearMocks);
it("scopes native window commands to the live page watcher and ignores stale events", async () => {
  const ipc = vi.fn(
    async (command: string, _args?: unknown) => {
      if (command === "pip_enter")
        return {
          active: true,
          transitioning: false,
          titleBarHeight: 31,
          revision: 1,
        };
      if (command === "pip_exit")
        return {
          active: false,
          transitioning: false,
          titleBarHeight: 31,
          revision: 2,
        };
    },
  );
  mockIPC(ipc);
  const update = vi.fn();
  const session =
    await nativePictureInPicture.watch(update);
  const args = ipc.mock.calls[0][1] as {
    watchId: string;
    events: Channel<NativePipState & { revision: number }>;
  };
  args.events.onmessage({
    active: true,
    transitioning: false,
    titleBarHeight: 31,
    revision: 0,
  });
  expect(update).toHaveBeenCalledWith({
    active: true,
    transitioning: false,
    titleBarHeight: 31,
  });
  await session.configure({
    eligible: true,
    automatic: true,
  });
  await session.enter();
  expect(ipc).toHaveBeenLastCalledWith("pip_enter", {
    watchId: args.watchId,
  });
  await session.exit();
  expect(ipc).toHaveBeenLastCalledWith("pip_exit", {
    watchId: args.watchId,
  });
  expect(update).toHaveBeenLastCalledWith({
    active: false,
    transitioning: false,
    titleBarHeight: 31,
  });
  update.mockClear();
  args.events.onmessage({
    active: true,
    transitioning: false,
    titleBarHeight: 31,
    revision: 1,
  });
  expect(update).not.toHaveBeenCalled();
  args.events.onmessage({
    active: true,
    transitioning: true,
    titleBarHeight: 31,
    revision: 3,
  });
  expect(update).toHaveBeenLastCalledWith({
    active: true,
    transitioning: true,
    titleBarHeight: 31,
  });
  args.events.onmessage({
    active: true,
    transitioning: false,
    titleBarHeight: 31,
    revision: 4,
  });
  expect(update).toHaveBeenLastCalledWith({
    active: true,
    transitioning: false,
    titleBarHeight: 31,
  });
  await session.close();
  await session.close();
  update.mockClear();
  args.events.onmessage({
    active: false,
    transitioning: false,
    titleBarHeight: 31,
    revision: 5,
  });
  expect(update).not.toHaveBeenCalled();
  await expect(session.enter()).rejects.toThrow("ended");
  expect(
    ipc.mock.calls.filter(([cmd]) => cmd === "pip_unwatch"),
  ).toHaveLength(1);
});
it("releases a partially registered native watcher after failure", async () => {
  const ipc = vi.fn(async (command: string) => {
    if (command === "pip_watch")
      throw new Error("unavailable");
  });
  mockIPC(ipc);
  await expect(
    nativePictureInPicture.watch(vi.fn()),
  ).rejects.toThrow("unavailable");
  expect(ipc).toHaveBeenLastCalledWith("pip_unwatch", {
    watchId: expect.any(String),
  });
});
it("reads OS autostart without changing it and only updates on an explicit set", async () => {
  const ipc = vi.fn(async (command: string, args) =>
    command === "application_autostart_set"
      ? { enabled: args.enabled, pathMismatch: false }
      : { enabled: true, pathMismatch: true },
  );
  mockIPC(ipc);
  expect(
    await nativeApplication.autostart!.status(),
  ).toEqual({
    enabled: true,
    pathMismatch: true,
  });
  expect(ipc).toHaveBeenCalledOnce();
  expect(ipc).toHaveBeenLastCalledWith(
    "application_autostart_status",
    {},
  );
  expect(
    await nativeApplication.autostart!.setEnabled(true),
  ).toEqual({ enabled: true, pathMismatch: false });
  expect(ipc).toHaveBeenLastCalledWith(
    "application_autostart_set",
    { enabled: true },
  );
});
