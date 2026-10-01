import { expect, it, vi } from "vitest";
import { keepDesktopActive } from "../src/background";

it("holds one shared lock for the desktop lifetime and releases it on teardown", async () => {
  const controller = new AbortController();
  let completed = false;
  const request = vi.fn(
    (
      _name: string,
      _options: LockOptions,
      callback: () => Promise<void>,
    ) =>
      callback().then(() => {
        completed = true;
      }),
  );
  keepDesktopActive(
    { request } as unknown as LockManager,
    controller.signal,
  );
  expect(request).toHaveBeenCalledWith(
    "weblink:desktop-runtime",
    { mode: "shared", signal: controller.signal },
    expect.any(Function),
  );
  await Promise.resolve();
  expect(completed).toBe(false);
  controller.abort();
  await Promise.resolve();
  expect(completed).toBe(true);
});

it("ignores unsupported or already disposed runtimes without acquiring a lock", () => {
  const controller = new AbortController();
  keepDesktopActive(undefined, controller.signal);
  controller.abort();
  const request = vi.fn();
  keepDesktopActive(
    { request } as unknown as LockManager,
    controller.signal,
  );
  expect(request).not.toHaveBeenCalled();
});

it("releases immediately if disposal races lock acquisition", async () => {
  const controller = new AbortController();
  const request = vi.fn(
    async (
      _name: string,
      _options: LockOptions,
      callback: () => Promise<void>,
    ) => {
      await Promise.resolve();
      await callback();
    },
  );
  keepDesktopActive(
    { request } as unknown as LockManager,
    controller.signal,
  );
  controller.abort();
  await expect(
    request.mock.results[0].value,
  ).resolves.toBeUndefined();
});
