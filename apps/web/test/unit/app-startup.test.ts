// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
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

function fixture() {
  const api = {
    enabled: vi.fn().mockResolvedValue(true),
    behavior: vi.fn().mockResolvedValue("window"),
    setEnabled: vi.fn().mockResolvedValue(false),
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
  expect(api.enabled).toHaveBeenCalledOnce();
  expect(api.behavior).toHaveBeenCalledOnce();
  expect(state.enabled()).toBe(true);
  expect(state.behavior()).toBe("window");
  const next = deferred<boolean>();
  api.enabled.mockReturnValueOnce(next.promise);
  window.dispatchEvent(new Event("focus"));
  const pending = state.refresh();
  expect(state.enabled()).toBe(true);
  expect(state.behavior()).toBe("window");
  next.resolve(false);
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
  const stale = deferred<boolean>();
  api.enabled.mockReturnValueOnce(stale.promise);
  const reading = state.refresh();
  await Promise.resolve();
  await state.setEnabled(false);
  await state.setBehavior("tray");
  stale.resolve(true);
  await reading;
  expect(state.enabled()).toBe(false);
  expect(state.behavior()).toBe("tray");
});

it("serializes writes, uses the actual native result, and allows retry after failure", async () => {
  const { state, api } = fixture();
  await state.refresh();
  const pending = deferred<boolean>();
  api.setEnabled.mockReturnValueOnce(pending.promise);
  const writing = state.setEnabled(false);
  await state.setBehavior("tray");
  expect(state.busy()).toBe(true);
  expect(api.setBehavior).not.toHaveBeenCalled();
  pending.resolve(true);
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
  api.enabled.mockRejectedValueOnce(
    new Error("IPC failed"),
  );
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
  const pending = deferred<boolean>();
  api.enabled.mockReturnValueOnce(pending.promise);
  const reading = state.refresh();
  await Promise.resolve();
  dispose();
  pending.resolve(true);
  await reading;
  window.dispatchEvent(new Event("focus"));
  expect(state.enabled()).toBeUndefined();
  expect(api.enabled).toHaveBeenCalledOnce();
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
