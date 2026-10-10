// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { reconcile } from "solid-js/store";
import type {
  InputDeviceSnapshot,
  NativeRemoteControl,
} from "@weblink/platform";
import { createAppInputDevices } from "@/libs/state/create-app-input-devices";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const disposers: (() => void)[] = [];
beforeEach(() =>
  setAppState(reconcile(createInitialAppState())),
);
afterEach(() =>
  disposers.splice(0).forEach((dispose) => dispose()),
);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(
  remoteControl?: Pick<NativeRemoteControl, "devices">,
) {
  let dispose!: () => void;
  const discovery = createRoot((stop) => {
    dispose = stop;
    return createAppInputDevices(remoteControl);
  });
  disposers.push(dispose);
  return { ...discovery, dispose };
}
function snapshot(
  availability: "driverRequired" | "available",
): InputDeviceSnapshot {
  return {
    capabilities: [
      { kind: "gamepad", availability, maxDevices: 4 },
    ],
    mounted: [],
  };
}

it("starts discovery at app mount and shares concurrent refreshes", async () => {
  const first = deferred<InputDeviceSnapshot>();
  const devices = vi.fn().mockReturnValue(first.promise);
  const { state, refresh } = fixture({ devices });
  expect(state).toBe(appState.capabilities.inputDevices);
  const pending = refresh();
  expect(refresh()).toBe(pending);
  window.dispatchEvent(new Event("focus"));
  await Promise.resolve();
  expect(devices).toHaveBeenCalledOnce();
  expect(state).toMatchObject({
    ready: false,
    refreshing: true,
    snapshot: null,
  });
  first.resolve(snapshot("driverRequired"));
  await pending;
  expect(state).toMatchObject({
    ready: true,
    refreshing: false,
    failed: false,
    snapshot: snapshot("driverRequired"),
  });
});

it("refreshes on focus without discarding the last successful result", async () => {
  const devices = vi
    .fn()
    .mockResolvedValueOnce(snapshot("driverRequired"));
  const { state, refresh } = fixture({ devices });
  await refresh();
  const next = deferred<InputDeviceSnapshot>();
  devices.mockReturnValueOnce(next.promise);
  window.dispatchEvent(new Event("focus"));
  const pending = refresh();
  expect(state.refreshing).toBe(true);
  expect(state.snapshot).toEqual(
    snapshot("driverRequired"),
  );
  next.resolve(snapshot("available"));
  await pending;
  expect(devices).toHaveBeenCalledTimes(2);
  expect(state.snapshot).toEqual(snapshot("available"));
});

it("preserves cached results after failure and allows retry", async () => {
  const devices = vi
    .fn()
    .mockResolvedValueOnce(snapshot("driverRequired"))
    .mockRejectedValueOnce(new Error("IPC unavailable"))
    .mockResolvedValue(snapshot("available"));
  const { state, refresh } = fixture({ devices });
  await refresh();
  await refresh();
  expect(state).toMatchObject({
    ready: true,
    refreshing: false,
    failed: true,
    snapshot: snapshot("driverRequired"),
  });
  await refresh();
  expect(state.failed).toBe(false);
  expect(state.snapshot).toEqual(snapshot("available"));
});

it.each([undefined, {}])(
  "does not probe hosts without input discovery (%s)",
  async (remoteControl) => {
    const { state, refresh } = fixture(remoteControl);
    await refresh();
    window.dispatchEvent(new Event("focus"));
    expect(state).toMatchObject({
      supported: false,
      ready: true,
      refreshing: false,
      snapshot: null,
    });
  },
);

it("removes focus listeners and ignores late results after app disposal", async () => {
  const first = deferred<InputDeviceSnapshot>();
  const devices = vi.fn().mockReturnValue(first.promise);
  const old = fixture({ devices });
  const pending = old.refresh();
  await Promise.resolve();
  old.dispose();
  const replacementDevices = vi
    .fn()
    .mockResolvedValue(snapshot("available"));
  const replacement = fixture({
    devices: replacementDevices,
  });
  await replacement.refresh();
  first.resolve(snapshot("driverRequired"));
  await pending;
  expect(replacement.state.snapshot).toEqual(
    snapshot("available"),
  );
  window.dispatchEvent(new Event("focus"));
  await replacement.refresh();
  await old.refresh();
  expect(devices).toHaveBeenCalledOnce();
  expect(replacementDevices).toHaveBeenCalledTimes(2);
});
