import { afterEach, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { createVisibilityWatcher } from "../src/visibility";

afterEach(() => {
  clearMocks();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("shares initial native state and releases its channel only after the last view closes", async () => {
  const ipc = vi.fn();
  mockIPC(ipc);
  const watch = createVisibilityWatcher();
  const first = vi.fn();
  const closeFirst = watch(first);
  await Promise.resolve();
  const [command, args] = ipc.mock.calls[0];
  expect(command).toBe("application_visibility_watch");
  args.events.onmessage(false);
  expect(first).toHaveBeenLastCalledWith(false);
  const second = vi.fn();
  const closeSecond = watch(second);
  expect(second).toHaveBeenCalledWith(false);
  expect(ipc).toHaveBeenCalledOnce();
  closeFirst();
  args.events.onmessage(true);
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenLastCalledWith(true);
  await Promise.resolve();
  closeSecond();
  closeSecond();
  await vi.waitFor(() =>
    expect(ipc).toHaveBeenLastCalledWith(
      "application_visibility_unwatch",
      { watchId: args.watchId },
    ),
  );
  args.events.onmessage(false);
  expect(second).toHaveBeenCalledTimes(2);
});

it("disposes a late registration without touching its replacement", async () => {
  let finish!: (close: () => void) => void;
  let stale!: (visible: boolean) => void;
  const oldClose = vi.fn();
  const newClose = vi.fn();
  const subscribe = vi.fn(
    (
      receive: (visible: boolean) => void,
    ): Promise<() => void> => {
      stale = receive;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  );
  const watch = createVisibilityWatcher(subscribe);
  const first = vi.fn();
  watch(first)();
  subscribe.mockImplementationOnce(async (receive) => {
    receive(false);
    return newClose;
  });
  const second = vi.fn();
  const close = watch(second);
  finish(oldClose);
  await Promise.resolve();
  stale(true);
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledWith(false);
  expect(oldClose).toHaveBeenCalledOnce();
  expect(newClose).not.toHaveBeenCalled();
  close();
  expect(newClose).toHaveBeenCalledOnce();
});

it("retries failed setup only while a view is listening", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const subscribe = vi
    .fn()
    .mockRejectedValue(new Error("IPC unavailable"));
  const watch = createVisibilityWatcher(subscribe);
  const close = watch(vi.fn());
  await vi.advanceTimersByTimeAsync(1000);
  expect(subscribe).toHaveBeenCalledTimes(2);
  close();
  await vi.advanceTimersByTimeAsync(5000);
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
