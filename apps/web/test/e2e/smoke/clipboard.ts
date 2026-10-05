import {
  beginBrowserClipboardWrite,
  fromBrowserPaste,
  supportsBrowserClipboardFiles,
  toNativeClipboard,
  type ClipboardContent,
} from "@/libs/application/clipboard-content";

const fixture = window as typeof window & {
  __CLIPBOARD_READY__?: boolean;
  __CLIPBOARD_COPIED__?: boolean;
  __SPEED_TEST_ERROR__?: string;
  __SPEED_TEST_REPORT__?: unknown;
};
const content: ClipboardContent = [
  {
    type: "file",
    name: "二进制.bin",
    blob: new Blob([new Uint8Array([0, 1, 128, 255])]),
  },
  { type: "file", name: "empty.txt", blob: new Blob([]) },
];
const fail = (error: unknown) => {
  fixture.__SPEED_TEST_ERROR__ = String(error);
};
const surface = document.getElementById("surface")!;
surface.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.code !== "KeyC") return;
  event.preventDefault();
  if (!supportsBrowserClipboardFiles())
    return fail("Custom clipboard format unavailable");
  // Simulate a transfer that outlasts transient user activation.
  const received = new Promise<ClipboardContent>(
    (resolve) => setTimeout(() => resolve(content), 6000),
  );
  void beginBrowserClipboardWrite(received, true)!.then(
    () => {
      fixture.__CLIPBOARD_COPIED__ = true;
    },
    fail,
  );
});
surface.addEventListener("paste", (event) => {
  event.preventDefault();
  if (!event.clipboardData)
    return fail("Missing paste data");
  void fromBrowserPaste(event.clipboardData, true)
    .then(async (restored) => {
      if (
        JSON.stringify(
          await toNativeClipboard(restored),
        ) !==
        JSON.stringify(await toNativeClipboard(content))
      )
        throw new Error(
          "File clipboard bytes or names changed",
        );
      fixture.__SPEED_TEST_REPORT__ = {
        ok: true,
        files: restored.length,
        delayedWrite: true,
        realPasteEvent: event.isTrusted,
      };
    })
    .catch(fail);
});
surface.focus();
fixture.__CLIPBOARD_READY__ = true;
