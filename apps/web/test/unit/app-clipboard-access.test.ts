// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import type { RuntimeCapabilities } from "@weblink/platform";
import { createAppClipboardAccess } from "@/libs/state/create-app-clipboard-access";
import { resolveRemoteKeyboardOptions } from "@/libs/domain/remote-control/keyboard-options";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const disposers: (() => void)[] = [];
beforeEach(() =>
  setAppState(reconcile(createInitialAppState())),
);
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it.each([
  ["cache", "cache"],
  ["off", "off"],
  ["clipboard", "clipboard"],
  ["invalid", undefined],
  [undefined, undefined],
])(
  "normalizes copied-file preference %s independently of synchronization",
  (value, expected) => {
    for (const clipboard of [true, false])
      expect(
        resolveRemoteKeyboardOptions({
          clipboard,
          clipboardFiles: value,
        }).clipboardFiles,
      ).toBe(expected);
  },
);
function permission(state: PermissionState) {
  return Object.assign(new EventTarget(), { state });
}
function browser(files = true) {
  const read = vi.fn();
  const write = vi.fn();
  const readPermission = permission("prompt");
  const writePermission = permission("granted");
  const query = vi.fn(async ({ name }: { name: string }) =>
    name === "clipboard-read"
      ? readPermission
      : writePermission,
  );
  const supports = vi.fn(() => files);
  vi.stubGlobal("navigator", {
    clipboard: { read, write },
    permissions: { query },
  });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      static supports = supports;
    },
  );
  vi.stubGlobal("isSecureContext", false);
  return {
    read,
    write,
    query,
    supports,
    readPermission,
    writePermission,
  };
}
function mount(
  options: Partial<
    Parameters<typeof createAppClipboardAccess>[0]
  > = {},
) {
  let dispose!: () => void;
  createRoot((stop) => {
    dispose = stop;
    createAppClipboardAccess({
      nativeClipboard: false,
      runtimeCapabilities: () => undefined,
      runtimeReady: async () => {},
      ...options,
    });
  });
  disposers.push(dispose);
  return {
    dispose,
    access: appState.capabilities.clipboard,
  };
}
const ready = () =>
  vi.waitFor(() =>
    expect(appState.capabilities.clipboard.ready).toBe(
      true,
    ),
  );

it.each([true, false])(
  "uses file cache even when browser custom formats are supported (%s), without enabling synchronization",
  async (supported) => {
    const api = browser(supported);
    const { access } = mount();
    expect(access.ready).toBe(false);
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBeUndefined();
    await ready();
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBe("cache");
    expect(access.writeFiles).toBe(false);
    expect(access.write).toBe(true);
    expect(appState.options.remoteKeyboard.clipboard).toBe(
      false,
    );
    expect(api.query).toHaveBeenCalledTimes(2);
    expect(api.supports).not.toHaveBeenCalled();
    expect(api.read).not.toHaveBeenCalled();
    expect(api.write).not.toHaveBeenCalled();
  },
);
it("uses file cache when clipboard APIs are absent", async () => {
  vi.stubGlobal("navigator", {});
  mount();
  await ready();
  expect(appState.capabilities.clipboard).toMatchObject({
    native: false,
    read: false,
    write: false,
    writeFiles: false,
  });
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("cache");
});
it("waits for denied permission before choosing a default, then preserves it on later grants", async () => {
  const api = browser();
  const pending = deferred<ReturnType<typeof permission>>();
  api.query.mockImplementation(({ name }) =>
    name === "clipboard-write"
      ? pending.promise
      : Promise.resolve(api.readPermission),
  );
  const { access } = mount();
  await Promise.resolve();
  expect(access.ready).toBe(false);
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBeUndefined();
  api.writePermission.state = "denied";
  pending.resolve(api.writePermission);
  await ready();
  expect(access.writeFiles).toBe(false);
  expect(access.writePermission).toBe("denied");
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("cache");
  api.writePermission.state = "granted";
  api.writePermission.dispatchEvent(new Event("change"));
  expect(access.writeFiles).toBe(false);
  expect(access.write).toBe(true);
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("cache");
  expect(api.query).toHaveBeenCalledTimes(2);
});
it.each(["clipboard", "cache", "off"] as const)(
  "preserves a saved %s choice through capability and permission changes",
  async (choice) => {
    const api = browser();
    api.writePermission.state = "denied";
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboardFiles",
      choice,
    );
    mount();
    await ready();
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBe(choice);
    api.writePermission.state = "granted";
    api.writePermission.dispatchEvent(new Event("change"));
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBe(choice);
  },
);
it("keeps a saved clipboard choice when permission is revoked instead of importing into file cache", async () => {
  const api = browser();
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "clipboard",
  );
  const { access } = mount();
  await ready();
  api.writePermission.state = "denied";
  api.writePermission.dispatchEvent(new Event("change"));
  expect(access.write).toBe(false);
  expect(access.writeFiles).toBe(false);
  expect(access.read).toBe(true);
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("clipboard");
});
it("uses API support when querying permissions fails synchronously or asynchronously", async () => {
  const api = browser();
  api.query.mockImplementation(({ name }) => {
    if (name === "clipboard-read")
      throw new TypeError("Unsupported permission");
    return Promise.reject(
      new TypeError("Unsupported permission"),
    );
  });
  const { access } = mount();
  await ready();
  expect(access).toMatchObject({
    read: true,
    write: true,
    writeFiles: false,
    readPermission: "unknown",
    writePermission: "unknown",
  });
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("cache");
});
it("waits for shared native capabilities and reuses subsequent updates", async () => {
  const api = browser(false);
  api.writePermission.state = "denied";
  const pending = deferred<void>();
  const [capabilities, setCapabilities] =
    createSignal<RuntimeCapabilities>();
  const { access } = mount({
    nativeClipboard: true,
    runtimeReady: () => pending.promise,
    runtimeCapabilities: capabilities,
  });
  await Promise.resolve();
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBeUndefined();
  const native: RuntimeCapabilities = {
    runtime: "desktop",
    os: "windows",
    version: null,
    nativeScreenCapture: false,
    displayRefreshRates: [],
    remoteInput: true,
    nativeClipboard: true,
  };
  setCapabilities(native);
  pending.resolve();
  await ready();
  expect(access).toMatchObject({
    native: true,
    read: true,
    write: true,
    writeFiles: true,
  });
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("clipboard");
  setCapabilities({ ...native, nativeClipboard: false });
  expect(access.native).toBe(false);
  expect(access.writeFiles).toBe(false);
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("clipboard");
  expect(api.query).toHaveBeenCalledTimes(2);
});
it("ignores late results after disposal and removes permission listeners", async () => {
  const api = browser();
  const { dispose, access } = mount();
  await ready();
  dispose();
  api.writePermission.state = "denied";
  api.writePermission.dispatchEvent(new Event("change"));
  expect(access.writePermission).toBe("granted");
  setAppState(reconcile(createInitialAppState()));
  const pending = deferred<ReturnType<typeof permission>>();
  api.query.mockReturnValue(pending.promise);
  const later = mount();
  later.dispose();
  pending.resolve(api.writePermission);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(appState.capabilities.clipboard.ready).toBe(false);
  expect(
    appState.capabilities.clipboard.writePermission,
  ).toBe("unknown");
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBeUndefined();
});
