// @vitest-environment jsdom
import { createRoot, createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import type {
  NativeUpdateCheck,
  NativeUpdateProgress,
  NativeUpdates,
} from "@weblink/platform";
import { createAppUpdates } from "@/libs/state/create-app-updates";

const available: NativeUpdateCheck = {
  status: "available",
  update: {
    version: "1.2.0",
    notes: "New version",
    canInstall: true,
    downloadKind: "installer",
    downloadUrl: "https://example.com/setup.exe",
  },
};
let dispose: () => void;
afterEach(() => dispose?.());
function setup(native: NativeUpdates) {
  return createRoot((cleanup) => {
    dispose = cleanup;
    return createAppUpdates(native);
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shares a pending startup/manual check and only checks once on startup", async () => {
  const request = deferred<NativeUpdateCheck>();
  const native = {
    check: vi.fn(() => request.promise),
    install: vi.fn(),
  };
  const updates = setup(native);
  const startup = updates.checkOnStartup(() => true);
  const manual = updates.check();
  expect(native.check).toHaveBeenCalledTimes(1);
  request.resolve(available);
  await Promise.all([startup, manual]);
  expect(updates.update()?.version).toBe("1.2.0");
  expect(updates.automaticUpdate()?.version).toBe("1.2.0");
  await updates.checkOnStartup(() => true);
  expect(native.check).toHaveBeenCalledTimes(1);
  expect(native.install).not.toHaveBeenCalled();
});

it("honors disabled startup checks while preserving manual checks", async () => {
  const native = {
    check: vi.fn().mockResolvedValue(available),
    install: vi.fn(),
  };
  const updates = setup(native);
  await updates.checkOnStartup(() => false);
  await updates.checkOnStartup(() => true);
  expect(native.check).not.toHaveBeenCalled();
  await updates.check();
  expect(updates.update()).toBeDefined();
  expect(updates.automaticUpdate()).toBeUndefined();
});

it("suppresses a startup notification if the switch is disabled during the request", async () => {
  const request = deferred<NativeUpdateCheck>();
  const [enabled, setEnabled] = createSignal(true);
  const updates = setup({
    check: () => request.promise,
    install: vi.fn(),
  });
  const startup = updates.checkOnStartup(enabled);
  setEnabled(false);
  request.resolve(available);
  await startup;
  expect(updates.automaticUpdate()).toBeUndefined();
});

it("clears stale install candidates after check errors and allows retry", async () => {
  const native = {
    check: vi
      .fn()
      .mockResolvedValueOnce(available)
      .mockRejectedValueOnce(new Error("Offline"))
      .mockResolvedValue({ status: "current" }),
    install: vi.fn(),
  };
  const updates = setup(native);
  await updates.check();
  await updates.check();
  expect(updates.update()).toBeUndefined();
  expect(updates.error()).toBe("check");
  await updates.install();
  expect(native.install).not.toHaveBeenCalled();
  await updates.check();
  expect(updates.result()).toEqual({ status: "current" });
  expect(updates.error()).toBeNull();
});

it("serializes installs, tracks progress, and permits retry after signature failures", async () => {
  const request = deferred<void>();
  let onProgress!: (value: NativeUpdateProgress) => void;
  const native = {
    check: vi.fn().mockResolvedValue(available),
    install: vi.fn((_version, receive) => {
      onProgress = receive;
      return request.promise;
    }),
  };
  const updates = setup(native);
  await updates.check();
  const install = updates.install();
  await updates.install();
  await updates.check();
  expect(native.install).toHaveBeenCalledTimes(1);
  expect(native.check).toHaveBeenCalledTimes(1);
  onProgress({
    phase: "downloading",
    downloaded: 50,
    total: 100,
  });
  expect(updates.percent()).toBe(50);
  request.reject(new Error("Invalid signature"));
  await install;
  expect(updates.error()).toBe("install");
  expect(updates.pending()).toBeNull();
  await updates.install();
  expect(native.install).toHaveBeenCalledTimes(2);
});

it("never installs portable updates", async () => {
  const native = {
    check: vi.fn().mockResolvedValue({
      ...available,
      update: {
        ...available.update,
        canInstall: false,
        downloadKind: "portable",
      },
    }),
    install: vi.fn(),
  };
  const updates = setup(native);
  await updates.check();
  await updates.install();
  expect(native.install).not.toHaveBeenCalled();
});

it("ignores a result arriving after application disposal", async () => {
  const request = deferred<NativeUpdateCheck>();
  const updates = setup({
    check: () => request.promise,
    install: vi.fn(),
  });
  const startup = updates.checkOnStartup(() => true);
  dispose();
  request.resolve(available);
  await startup;
  expect(updates.result()).toBeUndefined();
  expect(updates.automaticUpdate()).toBeUndefined();
});
