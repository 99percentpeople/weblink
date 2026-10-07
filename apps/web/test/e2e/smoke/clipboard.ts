import {
  beginBrowserClipboardWrite,
  fromPaste,
  readBrowserClipboard,
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
    type: "text/plain",
    blob: new Blob(["Weblink 剪贴板\nSecond line"], {
      type: "text/plain",
    }),
  },
];
// Windows clipboard text may use CRLF even when the source uses LF.
const clipboardText = async (value: ClipboardContent) => {
  if (value.length !== 1 || value[0].type !== "text/plain")
    throw new Error("Unexpected clipboard format");
  return (await value[0].blob.text()).replace(
    /\r\n/g,
    "\n",
  );
};
const fail = (error: unknown) => {
  fixture.__SPEED_TEST_ERROR__ = String(error);
};
const surface = document.getElementById("surface")!;
surface.addEventListener("keydown", (event) => {
  if (!event.ctrlKey || event.code !== "KeyC") return;
  event.preventDefault();
  // Simulate a transfer that outlasts transient user activation.
  const received = new Promise<ClipboardContent>(
    (resolve) => setTimeout(() => resolve(content), 6000),
  );
  void beginBrowserClipboardWrite(received)!.then(() => {
    fixture.__CLIPBOARD_COPIED__ = true;
  }, fail);
});
surface.addEventListener("paste", (event) => {
  event.preventDefault();
  if (!event.clipboardData)
    return fail("Missing paste data");
  void fromPaste(event.clipboardData)
    .then(async (restored) => {
      if (
        (await clipboardText(restored)) !==
        (await clipboardText(content))
      )
        throw new Error(
          "Clipboard text or line breaks changed",
        );
      const items = await navigator.clipboard.read();
      if (
        items.some((item) =>
          item.types.some((type) =>
            type.startsWith("web "),
          ),
        )
      )
        throw new Error(
          "Unexpected custom clipboard format",
        );
      const read = await readBrowserClipboard();
      if (
        (await clipboardText(read)) !==
        (await clipboardText(content))
      )
        throw new Error("Async clipboard text changed");
      fixture.__SPEED_TEST_REPORT__ = {
        ok: true,
        formats: restored.map((entry) => entry.type),
        delayedWrite: true,
        realPasteEvent: event.isTrusted,
      };
    })
    .catch(fail);
});
surface.focus();
fixture.__CLIPBOARD_READY__ = true;
