// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { NativeAutostartStatus } from "@weblink/platform";
import { createAppStartup } from "@/libs/state/create-app-startup";

const disposers: (() => void)[] = [];
afterEach(() =>
  disposers.splice(0).forEach((dispose) => dispose()),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}

function status(
  enabled = true,
  pathMismatch = false,
): NativeAutostartStatus {
  return { enabled, pathMismatch };
}

function fixture() {
  const api = {
    status: vi.fn().mockResolvedValue(status()),
    behavior: vi.fn().mockResolvedValue("window"),
    setEnabled: vi.fn().mockResolvedValue(status(false)),
    setBehavior: vi.fn().mockResolvedValue(undefined),
  };
  let dispose!: () => void;
  const state = createRoot((stop) => {
    dispose = stop;
    return createAppStartup(api);
  });
  disposers.push(dispose);
  return { state, api, dispose };
}

it("shares initial reads and retains loaded preferences during background refresh and failure", async () => {
  const { state, api } = fixture();
  await Promise.all([state.refresh(), state.refresh()]);
  expect(api.status).toHaveBeenCalledOnce();
  expect(api.behavior).toHaveBeenCalledOnce();
  expect(state.enabled()).toBe(true);
  expect(state.behavior()).toBe("window");
  const next = deferred<NativeAutostartStatus>();
  api.status.mockReturnValueOnce(next.promise);
  window.dispatchEvent(new Event("focus"));
  const pending = state.refresh();
  expect(state.enabled()).toBe(true);
  expect(state.behavior()).toBe("window");
  next.resolve(status(false));
  await pending;
  expect(state.enabled()).toBe(false);
  api.behavior.mockRejectedValueOnce(
    new Error("IPC failed"),
  );
  await state.refresh();
  expect(state.failed()).toBe(true);
  expect(state.enabled()).toBe(false);
  expect(state.behavior()).toBe("window");
});

it("does not let a stale background read overwrite a completed write", async () => {
  const { state, api } = fixture();
  await state.refresh();
  const stale = deferred<NativeAutostartStatus>();
  api.status.mockReturnValueOnce(stale.promise);
  const reading = state.refresh();
  await Promise.resolve();
  await state.setEnabled(false);
  await state.setBehavior("tray");
  stale.resolve(status());
  await reading;
  expect(state.enabled()).toBe(false);
  expect(state.behavior()).toBe("tray");
});

it("serializes writes, uses the actual native result, and allows retry after failure", async () => {
  const { state, api } = fixture();
  await state.refresh();
  const pending = deferred<NativeAutostartStatus>();
  api.setEnabled.mockReturnValueOnce(pending.promise);
  const writing = state.setEnabled(false);
  await state.setBehavior("tray");
  expect(state.busy()).toBe(true);
  expect(api.setBehavior).not.toHaveBeenCalled();
  pending.resolve(status());
  await writing;
  expect(state.enabled()).toBe(true);
  expect(state.busy()).toBe(false);
  api.setBehavior.mockRejectedValueOnce(
    new Error("IPC failed"),
  );
  await state.setBehavior("tray");
  expect(state.failed()).toBe(true);
  expect(state.behavior()).toBe("window");
  await state.setBehavior("tray");
  expect(state.failed()).toBe(false);
  expect(state.behavior()).toBe("tray");
});

it("retries an initial read failure on focus without allowing an uninformed write", async () => {
  const { state, api } = fixture();
  api.status.mockRejectedValueOnce(new Error("IPC failed"));
  await state.refresh();
  await state.setEnabled(true);
  expect(state.failed()).toBe(true);
  expect(state.enabled()).toBeUndefined();
  expect(api.setEnabled).not.toHaveBeenCalled();
  window.dispatchEvent(new Event("focus"));
  await state.refresh();
  expect(state.failed()).toBe(false);
  expect(state.enabled()).toBe(true);
});

it("ignores late results and releases focus observation with the app scope", async () => {
  const { state, api, dispose } = fixture();
  const pending = deferred<NativeAutostartStatus>();
  api.status.mockReturnValueOnce(pending.promise);
  const reading = state.refresh();
  await Promise.resolve();
  dispose();
  pending.resolve(status());
  await reading;
  window.dispatchEvent(new Event("focus"));
  expect(state.enabled()).toBeUndefined();
  expect(api.status).toHaveBeenCalledOnce();
});

it("does not expose native startup settings without a backend", async () => {
  const state = createRoot((dispose) => {
    disposers.push(dispose);
    return createAppStartup(undefined);
  });
  await state.refresh();
  await state.setEnabled(true);
  expect(state.supported).toBe(false);
  expect(state.enabled()).toBeUndefined();
  expect(state.failed()).toBe(false);
});

it("requires explicit repair of an enabled entry targeting another executable", async () => {
  const { state, api } = fixture();
  api.status.mockResolvedValue(status(true, true));
  await state.refresh();
  expect(state.pathMismatch()).toBe(true);
  expect(state.enabled()).toBe(false);
  await state.setEnabled(true);
  await state.setEnabled(false);
  expect(api.setEnabled).not.toHaveBeenCalled();

  const stale = deferred<NativeAutostartStatus>();
  api.status.mockReturnValueOnce(stale.promise);
  const reading = state.refresh();
  await Promise.resolve();
  const repaired = deferred<NativeAutostartStatus>();
  api.setEnabled.mockReturnValueOnce(repaired.promise);
  const repairing = state.repair();
  await state.repair();
  expect(api.setEnabled).toHaveBeenCalledOnce();
  expect(api.setEnabled).toHaveBeenCalledWith(true);
  expect(state.busy()).toBe(true);
  expect(state.pathMismatch()).toBe(true);
  repaired.resolve(status());
  await repairing;
  stale.resolve(status(true, true));
  await reading;
  expect(state.enabled()).toBe(true);
  expect(state.pathMismatch()).toBe(false);
  expect(state.failed()).toBe(false);
});

it("keeps failed or ineffective repairs retryable and verifies the native result", async () => {
  const { state, api } = fixture();
  api.status.mockResolvedValue(status(false, true));
  await state.refresh();
  api.setEnabled.mockRejectedValueOnce(
    new Error("Access denied"),
  );
  await state.repair();
  expect(state.failed()).toBe(true);
  expect(state.pathMismatch()).toBe(true);
  expect(state.busy()).toBe(false);
  api.setEnabled.mockResolvedValueOnce(status(true, true));
  await state.repair();
  expect(state.failed()).toBe(true);
  expect(state.enabled()).toBe(false);
  expect(state.pathMismatch()).toBe(true);
  api.setEnabled.mockResolvedValueOnce(status());
  await state.repair();
  expect(state.failed()).toBe(false);
  expect(state.enabled()).toBe(true);
  expect(state.pathMismatch()).toBe(false);
});

it("does not repair a missing or matching entry and detects external path changes on refresh", async () => {
  const { state, api } = fixture();
  api.status.mockResolvedValueOnce(status(false));
  await state.refresh();
  await state.repair();
  expect(state.pathMismatch()).toBe(false);
  expect(api.setEnabled).not.toHaveBeenCalled();
  await state.refresh();
  await state.repair();
  expect(api.setEnabled).not.toHaveBeenCalled();
  api.status.mockResolvedValueOnce(status(true, true));
  window.dispatchEvent(new Event("focus"));
  await state.refresh();
  expect(state.enabled()).toBe(false);
  expect(state.pathMismatch()).toBe(true);
  expect(api.setEnabled).not.toHaveBeenCalled();
});
