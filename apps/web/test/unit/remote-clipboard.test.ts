// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
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
import type { ClipboardCopyOptions } from "@/libs/application/remote-clipboard";
import type { RuntimeCapabilities } from "@weblink/platform";
import { createAppClipboardAccess } from "@/libs/state/create-app-clipboard-access";
import { deferred } from "../support/rtc-transport";
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
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setAppState(reconcile(createInitialAppState()));
});
it("waits for a host change before reading or writing clipboard content", async () => {
  const { write, read } = browser(true);
  const { readCurrent, changed } = await mountClipboard([
    { type: "text/plain", blob: new Blob(["new"]) },
    { type: "text/html", blob: new Blob(["<b>new</b>"]) },
  ]);
  await Promise.resolve();
  expect(readCurrent).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  expect(
    Object.keys((write.mock.calls[0] as any)[0][0].data),
  ).toEqual(["text/plain", "text/html"]);
});
it("skips local writes and feedback when a notified clipboard has already been cleared", async () => {
  const { write } = browser(true);
  const { changed, readCurrent } = await mountClipboard([]);
  changed();
  await readCurrent.mock.results[0].value;
  expect(write).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});
it("coalesces changes during a write and reads the latest content once", async () => {
  const { write } = browser(true);
  const content: ClipboardContent = [
    { type: "text/plain", blob: new Blob(["first"]) },
  ];
  const { changed, readCurrent } =
    await mountClipboard(content);
  let finish!: () => void;
  write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  content[0] = {
    type: "text/plain",
    blob: new Blob(["latest"]),
  };
  changed();
  changed();
  expect(readCurrent).toHaveBeenCalledOnce();
  finish();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledTimes(2),
  );
  expect(readCurrent).toHaveBeenCalledTimes(2);
  expect(
    (write.mock.calls[1] as any)[0][0].data["text/plain"],
  ).toBe(content[0].blob);
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
  const readCurrent = vi.fn(
    async (
      _peer: string,
      _control: RemotePointer,
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
    async (_peer, _control, content: ClipboardContent) => {
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
  const clipboard = {
    readCurrent,
    paste,
    watch,
  };
  const control = {
    clipboardGrant: () => "grant",
    clipboardEpoch: () => "epoch",
  };
  render(() => {
    mountAccess();
    const { pasteEvent } = createRemoteClipboard({
      clientId: "peer",
      control: control as unknown as RemotePointer,
      state: "active",
      enabled: true,
      clipboard,
    });
    const input = document.createElement("textarea");
    input.addEventListener("paste", pasteEvent);
    return input;
  });
  await vi.waitFor(() =>
    expect(appState.capabilities.clipboard.ready).toBe(
      true,
    ),
  );
  return {
    control,
    readCurrent,
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
function pasteText(text: string) {
  fireEvent.paste(document.querySelector("textarea")!, {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain" ? text : "",
      items: [],
    },
  });
}
it("keeps distinct system pastes in gesture order while a host copy is being written", async () => {
  const { write } = browser(true);
  const writing = deferred<void>();
  write.mockReturnValueOnce(writing.promise);
  const { changed, paste } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  const applied = deferred<void>();
  paste.mockImplementationOnce(() => applied.promise);
  pasteText("A");
  pasteText("BB");
  expect(paste).not.toHaveBeenCalled();
  writing.resolve();
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledOnce(),
  );
  applied.resolve();
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledTimes(2),
  );
  expect(
    paste.mock.calls.map(
      ([, , entries]) => entries[0].blob.size,
    ),
  ).toEqual([1, 2]);
});
it.each([
  "focus reset",
  "disable and re-enable",
  "unmount",
])("discards queued paste after %s", async (change) => {
  const { write } = browser(true);
  const writing = deferred<void>();
  write.mockReturnValueOnce(writing.promise);
  const { changed, paste, control } =
    await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  pasteText("private");
  if (change === "focus reset")
    vi.spyOn(control, "clipboardEpoch").mockReturnValue(
      "next",
    );
  else if (change === "unmount") cleanup();
  else {
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboard",
      false,
    );
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboard",
      true,
    );
  }
  writing.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(paste).not.toHaveBeenCalled();
});
it("allows a local paste when a host copy is waiting for a browser write gesture", async () => {
  const { write } = browser(true);
  write.mockRejectedValueOnce(
    new DOMException("Denied", "NotAllowedError"),
  );
  const { changed, paste } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(toast.info).toHaveBeenCalledOnce(),
  );
  pasteText("");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(toast.dismiss).not.toHaveBeenCalled();
  expect(paste).not.toHaveBeenCalled();
  pasteText("local");
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledOnce(),
  );
  expect(toast.dismiss).toHaveBeenCalledOnce();
  expect(toast.error).not.toHaveBeenCalled();
});
it("skips empty or unsupported paste events without probing the clipboard", async () => {
  const { read, write } = browser(true);
  const { paste } = await mountClipboard();
  fireEvent.paste(document.querySelector("textarea")!, {
    clipboardData: {
      getData: () => "",
      items: [
        {
          kind: "string",
          type: "application/custom",
          getAsFile: () => null,
        },
      ],
    },
  });
  expect(read).not.toHaveBeenCalled();
  pasteText("");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(paste).not.toHaveBeenCalled();
  expect(write).not.toHaveBeenCalled();
  expect(toast.error).not.toHaveBeenCalled();
  expect(toast.info).not.toHaveBeenCalled();
});
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
  const { changed, readCurrent, paste } =
    await mountClipboard();
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
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(readCurrent).toHaveBeenCalledOnce();
  expect(readCurrent.mock.calls[0][2]).toMatchObject({
    files: true,
    formats: expect.arrayContaining([
      "text/plain",
      "image/png",
    ]),
  });
  pasteText("local");
  expect(read).not.toHaveBeenCalled();
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
  const { readCurrent, paste, watch } =
    await mountClipboard();
  expect(paste).not.toHaveBeenCalled();
  expect(readCurrent).not.toHaveBeenCalled();
  expect(watch).not.toHaveBeenCalled();
  fireEvent.paste(document.querySelector("textarea")!, {
    clipboardData: {
      getData: (type: string) =>
        type === "text/plain" ? "from HTTP" : "",
      items: [],
    },
  });
  await vi.waitFor(() =>
    expect(paste).toHaveBeenCalledOnce(),
  );
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
  const { watch, stop } = await mountClipboard();
  await vi.waitFor(() =>
    expect(watch).toHaveBeenCalledOnce(),
  );
  expect(read).not.toHaveBeenCalled();
  writePermission.state = "denied";
  writePermission.dispatchEvent(new Event("change"));
  expect(stop).toHaveBeenCalledOnce();
  expect(write).not.toHaveBeenCalled();
  writePermission.state = "granted";
  writePermission.dispatchEvent(new Event("change"));
  expect(watch).toHaveBeenCalledTimes(2);
});
it("retries the received text from the permission prompt without another transfer", async () => {
  const { write } = browser(true);
  write.mockRejectedValueOnce(
    new DOMException("Denied", "NotAllowedError"),
  );
  const { changed, readCurrent } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(toast.info).toHaveBeenCalledOnce(),
  );
  const options = vi.mocked(toast.info).mock.calls[0][1]!;
  (
    options.action as { onClick(event: MouseEvent): void }
  ).onClick(new MouseEvent("click"));
  await vi.waitFor(() =>
    expect(toast.dismiss).toHaveBeenCalledOnce(),
  );
  expect(write).toHaveBeenCalledTimes(2);
  expect(readCurrent).toHaveBeenCalledOnce();
  expect(toast.error).not.toHaveBeenCalled();
});
it("naturally synchronizes remote context-menu copies and stops watching when disabled", async () => {
  const { write, read } = browser(true);
  const { changed, readCurrent, stop } =
    await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
  expect(readCurrent).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
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
  expect(readCurrent).toHaveBeenCalledOnce();
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
    const { watch } = await mountClipboard();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(watch).not.toHaveBeenCalled();
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
  const { changed, readCurrent } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(readCurrent).toHaveBeenCalledOnce(),
  );
  await vi.waitFor(() =>
    expect(write).toHaveBeenCalledOnce(),
  );
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
  const { changed, readCurrent, watch, stop } =
    await mountClipboard();
  await vi.waitFor(() =>
    expect(watch).toHaveBeenCalledOnce(),
  );
  changed();
  await vi.waitFor(() =>
    expect(readCurrent).toHaveBeenCalledOnce(),
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "off",
  );
  expect(stop).toHaveBeenCalledOnce();
});
it("requests copied files without changing the clipboard destination", async () => {
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
  const { changed, readCurrent } = await mountClipboard();
  changed();
  await vi.waitFor(() =>
    expect(readCurrent).toHaveBeenCalledWith(
      "peer",
      expect.anything(),
      expect.objectContaining({
        files: true,
        formats: ["text/plain"],
      }),
    ),
  );
});
it("requests cache files without text or images when browser writing is unavailable", async () => {
  vi.stubGlobal("navigator", {});
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "cache",
  );
  const { changed, readCurrent } = await mountClipboard();
  changed();
  expect(readCurrent).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
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
    const { changed, readCurrent } =
      await mountClipboard(files);
    changed();
    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledOnce(),
    );
    expect(readCurrent).toHaveBeenCalledWith(
      "peer",
      expect.anything(),
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
  const { changed, readCurrent } =
    await mountClipboard(image);
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
  expect(readCurrent).toHaveBeenCalledOnce();
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
  const { changed, readCurrent } = await mountClipboard([
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
  expect(readCurrent).toHaveBeenCalledWith(
    "peer",
    expect.anything(),
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
