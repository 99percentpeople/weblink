/** Copy from a user gesture, including HTTP pages without the Clipboard API. */
export async function copyText(
  text: string,
): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission policies may deny the modern API even on HTTPS.
    }
  }
  // Keep this synchronous when the Clipboard API is absent: mobile browsers
  // require the legacy operation to stay inside the button's user gesture.
  const active = document.activeElement;
  const selection = document.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) =>
        selection.getRangeAt(i).cloneRange(),
      )
    : [];
  const input = document.createElement("textarea");
  input.value = text;
  input.readOnly = true;
  input.tabIndex = -1;
  input.style.cssText =
    "position:fixed;top:0;left:0;opacity:0;pointer-events:none";
  try {
    (document.fullscreenElement ?? document.body).append(
      input,
    );
    input.focus({ preventScroll: true });
    input.select();
    input.setSelectionRange(0, text.length);
    return document.execCommand?.("copy") === true;
  } catch {
    return false;
  } finally {
    input.remove();
    if (active instanceof HTMLElement && active.isConnected)
      active.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges) selection.addRange(range);
    }
  }
}
