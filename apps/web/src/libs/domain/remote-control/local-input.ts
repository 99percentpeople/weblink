import { remoteScanCode } from "./keyboard";

/** Cross-document safe, including editors inside shadow roots and PiP windows. */
export function isLocalTextTarget(
  target: EventTarget | null,
): boolean {
  const element = target as Element | null;
  if (typeof element?.closest !== "function") return false;
  return !!element.closest(
    '[role="dialog"], textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], input:not([type="button"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="hidden"])',
  );
}

/** Device hint only: viewport width cannot distinguish a phone from a small desktop window. */
export function isMobileInputDevice(
  browser:
    | Pick<
        Navigator,
        "userAgent" | "platform" | "maxTouchPoints"
      >
    | undefined = globalThis.navigator,
): boolean {
  if (!browser) return false;
  return (
    /Android|iPhone|iPad|iPod/i.test(browser.userAgent) ||
    (browser.platform === "MacIntel" &&
      browser.maxTouchPoints > 1)
  );
}

/** Browsers cannot enumerate keyboards. Ignore typing/IME in editors and observe keyboard use elsewhere. */
export function isKeyboardEvidence(
  event: Pick<
    KeyboardEvent,
    "isTrusted" | "isComposing" | "keyCode" | "key" | "code"
  >,
  editable: boolean,
): boolean {
  return (
    event.isTrusted &&
    !editable &&
    !event.isComposing &&
    event.keyCode !== 229 &&
    event.key !== "Process" &&
    remoteScanCode(event.code) !== undefined
  );
}
