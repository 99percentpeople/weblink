// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import {
  cleanup,
  fireEvent,
  render,
} from "@solidjs/testing-library";
import { toast } from "solid-sonner";
import { platform } from "@/libs/platform/runtime";
import { reconcile } from "solid-js/store";
import { createRemoteClipboard } from "@/libs/hooks/create-remote-clipboard";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { ClipboardCopyOptions } from "@/libs/application/remote-clipboard";
import type { RuntimeCapabilities } from "@weblink/platform";
import { createAppClipboardAccess } from "@/libs/state/create-app-clipboard-access";
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn() },
}));
let dispose: (() => void) | undefined;
function mountAccess() {
  let capabilities: RuntimeCapabilities | undefined;
  createAppClipboardAccess({
    nativeClipboard: !!platform.clipboard,
    runtimeCapabilities: () => capabilities,
    runtimeReady: async () => {
      capabilities = await platform.getCapabilities();
    },
  });
}
afterEach(() => {
  cleanup();
  dispose?.();
  dispose = undefined;
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setAppState(reconcile(createInitialAppState()));
});
it("successive copy gestures fetch new selections and automatically write rich formats", async () => {
  vi.stubGlobal("isSecureContext", true);
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  const copy = vi.fn(
    async (
      _peer: string,
      _control: RemotePointer,
      _selection: boolean,
      options?: ClipboardCopyOptions,
    ) => {
      const content = [
        {
          type: "text/plain" as const,
          blob: new Blob(["text"]),
        },
        {
          type: "text/html" as const,
          blob: new Blob(["<b>text</b>"]),
        },
      ];
      await options?.receive?.(
        content,
        new AbortController().signal,
      );
      return content;
    },
  );
  const clipboard: AppStateContextProps["remoteClipboard"] =
    { copy, paste: vi.fn(), watch: () => () => {} };
  const write = vi.fn(async () => {});
  vi.stubGlobal("navigator", { clipboard: { write } });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      static supports = () => true;
      constructor(readonly data: unknown) {}
    },
  );
  const control = {
    clipboardGrant: () => "grant",
  } as RemotePointer;
  const actions = createRoot((stop) => {
    dispose = stop;
    mountAccess();
    return createRemoteClipboard({
      clientId: "peer",
      control,
      state: "active",
      enabled: true,
      clipboard,
    });
  });
  await vi.waitFor(() =>
    expect(appState.capabilities.clipboard.ready).toBe(
      true,
    ),
  );
  actions.copy();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledTimes(2),
  );
  // Let the clipboard write and busy-state cleanup settle.
  await new Promise((resolve) => setTimeout(resolve, 0));
  actions.copy();
  await vi.waitFor(() =>
    expect(copy).toHaveBeenCalledTimes(2),
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    false,
  );
  expect(actions.enabled()).toBe(false);
  actions.copy();
  expect(copy).toHaveBeenCalledTimes(2);
  expect(appState.options.remoteKeyboard.clipboard).toBe(
    false,
  );
});

async function mountClipboard() {
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  const copy = vi.fn(
    async (
      _peer: string,
      _control: RemotePointer,
      _selection: boolean,
      options?: ClipboardCopyOptions,
    ) => {
      const content = [
        {
          type: "text/plain" as const,
          blob: new Blob(["remote"]),
        },
      ];
      await options?.receive?.(
        content,
        new AbortController().signal,
      );
      return content;
    },
  );
  const paste = vi.fn(
    async (
      _peer,
      _control,
      content: Promise<
        import("@/libs/application/clipboard-content").ClipboardContent
      >,
    ) => {
      await content;
    },
  );
  const stop = vi.fn();
  let changed: (() => void) | undefined;
  const watch = vi.fn(
    (_peer, _control, notify: () => void) => {
      changed = notify;
      return stop;
    },
  );
  const clipboard = { copy, paste, watch };
  const control = {
    clipboardGrant: () => "grant",
  } as RemotePointer;
  let actions!: ReturnType<typeof createRemoteClipboard>;
  render(() => {
    mountAccess();
    actions = createRemoteClipboard({
      clientId: "peer",
      control,
      state: "active",
      enabled: true,
      clipboard,
    });
    const input = document.createElement("textarea");
    input.addEventListener("paste", actions.pasteEvent);
    return input;
  });
  await vi.waitFor(() =>
    expect(appState.capabilities.clipboard.ready).toBe(
      true,
    ),
  );
  return {
    actions,
    copy,
    paste,
    watch,
    stop,
    changed: () => changed?.(),
  };
}
function browser(secure: boolean) {
  vi.stubGlobal("isSecureContext", secure);
  const write = vi.fn(async () => {});
  const read = vi.fn(async () => []);
  vi.stubGlobal("navigator", {
    clipboard: { write, read },
  });
  vi.stubGlobal(
    "ClipboardItem",
    class {
      static supports = () => true;
      constructor(readonly data: unknown) {}
    },
  );
  return { write, read };
}
it("accepts a real system paste without clipboard APIs or action buttons", async () => {
  const { write, read } = browser(false);
  vi.stubGlobal("navigator", {});
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "clipboard",
  );
  const { actions, copy, paste, watch } =
    await mountClipboard();
  expect(actions.canCopy()).toBe(false);
  expect(actions.copy()).toBe(false);
  expect(actions.paste()).toBe(false);
  expect(copy).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
  fireEvent.paste(document.querySelector("textarea")!, {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain" ? "from HTTP" : "",
      items: [],
    },
  });
  expect(paste).toHaveBeenCalledOnce();
  const content = await paste.mock.calls[0][2];
  expect(
    content.map((entry) => [entry.type, entry.blob.size]),
  ).toEqual([["text/plain", 9]]);
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});
it("updates read and write permissions independently without probing clipboard contents", async () => {
  const { write, read } = browser(true);
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "clipboard",
  );
  const readPermission = Object.assign(new EventTarget(), {
    state: "denied",
  });
  const writePermission = Object.assign(new EventTarget(), {
    state: "granted",
  });
  Object.assign(navigator, {
    permissions: {
      query: vi.fn(async ({ name }) =>
        name === "clipboard-read"
          ? readPermission
          : writePermission,
      ),
    },
  });
  const { actions, watch, stop } = await mountClipboard();
  await vi.waitFor(() =>
    expect(watch).toHaveBeenCalledOnce(),
  );
  expect(actions.canCopy()).toBe(true);
  expect(actions.paste()).toBe(false);
  expect(read).not.toHaveBeenCalled();
  writePermission.state = "denied";
  writePermission.dispatchEvent(new Event("change"));
  expect(actions.canCopy()).toBe(false);
  expect(stop).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  writePermission.state = "granted";
  writePermission.dispatchEvent(new Event("change"));
  expect(actions.canCopy()).toBe(true);
});
it("retries on the next real copy and emits no toast for failed operations", async () => {
  const { write, read } = browser(true);
  write.mockRejectedValueOnce(
    new DOMException("Denied", "NotAllowedError"),
  );
  read.mockRejectedValueOnce(
    new DOMException("Denied", "NotAllowedError"),
  );
  const { actions, copy, paste } = await mountClipboard();
  actions.copy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  actions.copy();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledTimes(2),
  );
  expect(copy).toHaveBeenCalledTimes(2);
  await new Promise((resolve) => setTimeout(resolve, 0));
  actions.paste();
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledOnce(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});
it("naturally synchronizes remote context-menu copies and stops watching when disabled", async () => {
  const { write, read } = browser(true);
  const { changed, copy, stop } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  expect(copy).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
    false,
    expect.objectContaining({
      receive: expect.any(Function),
    }),
  );
  expect(read).not.toHaveBeenCalled();
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    false,
  );
  expect(stop).toHaveBeenCalledOnce();
  changed();
  expect(copy).toHaveBeenCalledOnce();
});
it("uses native availability instead of assuming that a bridge means clipboard support", async () => {
  browser(false);
  vi.stubGlobal("navigator", {});
  const native = platform.clipboard;
  platform.clipboard = {
    read: vi.fn(),
    write: vi.fn(),
  } as any;
  vi.spyOn(platform, "getCapabilities").mockResolvedValue({
    runtime: "desktop",
    os: "linux",
    version: null,
    nativeScreenCapture: false,
    displayRefreshRates: [],
    remoteInput: false,
    nativeClipboard: false,
  });
  try {
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboardFiles",
      "clipboard",
    );
    const { actions } = await mountClipboard();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actions.canCopy()).toBe(false);
    expect(
      platform.clipboard!.write,
    ).not.toHaveBeenCalled();
    expect(platform.clipboard!.read).not.toHaveBeenCalled();
  } finally {
    platform.clipboard = native;
  }
});

it("uses actual browser APIs even when the context flag is false", async () => {
  const { write } = browser(false);
  const { actions, copy } = await mountClipboard();
  expect(actions.canCopy()).toBe(true);
  expect(actions.copy()).toBe(true);
  await vi.waitFor(() =>
    expect(copy).toHaveBeenCalledOnce(),
  );
  expect(write).toHaveBeenCalledOnce();
  expect(toast.info).not.toHaveBeenCalled();
});

it("allows file-cache copying and context-menu watching without browser clipboard APIs", async () => {
  vi.stubGlobal("navigator", {});
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "cache",
  );
  const { actions, copy, watch } = await mountClipboard();
  await vi.waitFor(() =>
    expect(watch).toHaveBeenCalledOnce(),
  );
  expect(actions.canCopy()).toBe(true);
  expect(actions.copy()).toBe(true);
  await vi.waitFor(() =>
    expect(copy).toHaveBeenCalledOnce(),
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "off",
  );
  expect(actions.canCopy()).toBe(false);
});
it.each([true, false])(
  "excludes files from a saved browser clipboard choice even with custom format support (selection=%s)",
  async (selection) => {
    browser(true);
    vi.stubGlobal(
      "ClipboardItem",
      class {
        static supports = (type: string) =>
          type === "text/plain" || type.startsWith("web ");
        constructor(readonly data: unknown) {}
      },
    );
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboardFiles",
      "clipboard",
    );
    const { actions, copy } = await mountClipboard();
    expect(actions.copy(selection)).toBe(true);
    await vi.waitFor(() =>
      expect(copy).toHaveBeenCalledWith(
        "peer",
        expect.anything(),
        selection,
        expect.objectContaining({
          files: false,
          formats: ["text/plain"],
        }),
      ),
    );
  },
);
it("requests cache files without text or images when browser writing is unavailable", async () => {
  vi.stubGlobal("navigator", {});
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "cache",
  );
  const { actions, copy } = await mountClipboard();
  actions.copy();
  expect(copy).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
    true,
    expect.objectContaining({ files: true, formats: [] }),
  );
});
