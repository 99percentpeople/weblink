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
import type { ClipboardContent } from "@/libs/application/clipboard-content";
import { browserClipboardContent } from "@/libs/application/browser-clipboard-files";
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
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    dismiss: vi.fn(),
  },
}));
vi.mock(
  "@/libs/application/browser-clipboard-files",
  () => ({
    browserClipboardContent: vi.fn(
      async (content: ClipboardContent) => content,
    ),
  }),
);
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

async function mountClipboard(
  content: ClipboardContent = [
    { type: "text/plain", blob: new Blob(["remote"]) },
  ],
) {
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
  const read = vi.fn(
    async (): Promise<
      Pick<ClipboardItem, "types" | "getType">[]
    > => [],
  );
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
it("allows copy and paste gestures while browser permissions are still prompt", async () => {
  const { write, read } = browser(true);
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "clipboard",
  );
  const permission = Object.assign(new EventTarget(), {
    state: "prompt",
  });
  Object.assign(navigator, {
    permissions: { query: vi.fn(async () => permission) },
  });
  read.mockResolvedValue([
    {
      types: ["text/plain"],
      getType: async () => new Blob(["local"]),
    },
  ]);
  const { actions, copy, paste } = await mountClipboard();
  expect(appState.capabilities.clipboard).toMatchObject({
    ready: true,
    readPermission: "prompt",
    writePermission: "prompt",
    read: true,
    write: true,
    writeFiles: false,
  });
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(actions.copy()).toBe(true);
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(copy).toHaveBeenCalledOnce();
  expect(copy.mock.calls[0][3]).toMatchObject({
    files: true,
    formats: expect.arrayContaining([
      "text/plain",
      "image/png",
    ]),
  });
  expect(actions.paste()).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledOnce(),
  );
  const content = await paste.mock.calls[0][2];
  expect(
    content.map((entry) => [entry.type, entry.blob.size]),
  ).toEqual([["text/plain", 5]]);
});
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
    expect(write).toHaveBeenCalledTimes(3),
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
  "requests copied files without changing the clipboard destination (selection=%s)",
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
          files: true,
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
it.each(["png", "jpg"])(
  "receives a copied %s file in limited clipboard mode and writes the converted image",
  async (extension) => {
    const { write } = browser(true);
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboardFiles",
      "clipboard",
    );
    const files: ClipboardContent = [
      {
        type: "file",
        name: `photo.${extension}`,
        blob: new Blob(["file bytes"]),
      },
    ];
    const image: ClipboardContent = [
      {
        type: "image/png",
        blob: new Blob(["converted image"], {
          type: "image/png",
        }),
      },
    ];
    vi.mocked(
      browserClipboardContent,
    ).mockResolvedValueOnce(image);
    const { changed, copy } = await mountClipboard(files);
    changed();
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledOnce(),
    );
    expect(copy).toHaveBeenCalledWith(
      "peer",
      expect.anything(),
      false,
      expect.objectContaining({ files: true }),
    );
    expect(browserClipboardContent).toHaveBeenCalledWith(
      files,
      expect.any(AbortSignal),
    );
    const data = (write.mock.calls[0] as any)[0][0].data;
    expect(Object.keys(data)).toEqual(["image/png"]);
    expect(data["image/png"]).toBe(image[0].blob);
  },
);
it("retains an image when automatic writing is denied and retries from a click without retransmission", async () => {
  const { write } = browser(true);
  write.mockRejectedValueOnce(
    new DOMException(
      "User activation required",
      "NotAllowedError",
    ),
  );
  const image: ClipboardContent = [
    {
      type: "image/png",
      blob: new Blob(["image bytes"], {
        type: "image/png",
      }),
    },
  ];
  const { changed, copy } = await mountClipboard(image);
  changed();
  await vi.waitFor(() =>
    expect(toast.info).toHaveBeenCalledOnce(),
  );
  const options = vi.mocked(toast.info).mock.calls[0][1]!;
  (
    options.action as {
      onClick: (event: MouseEvent) => void;
    }
  ).onClick(new MouseEvent("click"));
  await vi.waitFor(() =>
    expect(toast.dismiss).toHaveBeenCalled(),
  );
  expect(copy).toHaveBeenCalledOnce();
  expect(write).toHaveBeenCalledTimes(2);
  expect(
    (write.mock.calls[1] as any)[0][0].data["image/png"],
  ).toBe(image[0].blob);
});
it("reports unsupported PDF copying without changing the clipboard or file destination", async () => {
  const { write } = browser(true);
  vi.mocked(browserClipboardContent).mockRejectedValueOnce(
    new Error("clipboard-file-unsupported"),
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "clipboard",
  );
  const { changed, copy } = await mountClipboard([
    {
      type: "file",
      name: "test.pdf",
      blob: new Blob(["%PDF-1.4"]),
    },
  ]);
  changed();
  await vi.waitFor(() =>
    expect(toast.error).toHaveBeenCalledWith(
      "remote_control.clipboard_write_failed",
      {
        description:
          "remote_control.clipboard_file_unsupported",
      },
    ),
  );
  expect(copy).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
    false,
    expect.objectContaining({ files: true }),
  );
  expect(write).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("clipboard");
});
it("dismisses the pending image write when the controller surface is unmounted", async () => {
  const { write } = browser(true);
  write.mockRejectedValue(
    new DOMException("Denied", "NotAllowedError"),
  );
  const { changed } = await mountClipboard([
    { type: "image/png", blob: new Blob(["image"]) },
  ]);
  changed();
  await vi.waitFor(() =>
    expect(toast.info).toHaveBeenCalledOnce(),
  );
  const options = vi.mocked(toast.info).mock.calls[0][1]!;
  cleanup();
  expect(toast.dismiss).toHaveBeenCalled();
  (
    options.action as {
      onClick: (event: MouseEvent) => void;
    }
  ).onClick(new MouseEvent("click"));
  expect(write).toHaveBeenCalledOnce();
});
