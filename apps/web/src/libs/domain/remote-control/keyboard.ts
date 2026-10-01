import type { RemoteKeyboardOptions } from "./keyboard-options";

export interface RemoteKeyEvent {
  type: "key";
  scanCode: number;
  extended: boolean;
  down: boolean;
}
type Key = Pick<RemoteKeyEvent, "scanCode" | "extended">;
export type BrowserKey = Pick<
  KeyboardEvent,
  | "code"
  | "key"
  | "repeat"
  | "isComposing"
  | "ctrlKey"
  | "altKey"
  | "shiftKey"
  | "metaKey"
>;

// DOM physical codes -> Windows set-1 scan codes. Bit 8 represents the E0 prefix.
// Keep this within the native ScanCode whitelist; Pause/PrintScreen need special sequences.
const scanCodes: Readonly<Record<string, number>> = {
  Escape: 0x01,
  Digit1: 0x02,
  Digit2: 0x03,
  Digit3: 0x04,
  Digit4: 0x05,
  Digit5: 0x06,
  Digit6: 0x07,
  Digit7: 0x08,
  Digit8: 0x09,
  Digit9: 0x0a,
  Digit0: 0x0b,
  Minus: 0x0c,
  Equal: 0x0d,
  Backspace: 0x0e,
  Tab: 0x0f,
  KeyQ: 0x10,
  KeyW: 0x11,
  KeyE: 0x12,
  KeyR: 0x13,
  KeyT: 0x14,
  KeyY: 0x15,
  KeyU: 0x16,
  KeyI: 0x17,
  KeyO: 0x18,
  KeyP: 0x19,
  BracketLeft: 0x1a,
  BracketRight: 0x1b,
  Enter: 0x1c,
  ControlLeft: 0x1d,
  KeyA: 0x1e,
  KeyS: 0x1f,
  KeyD: 0x20,
  KeyF: 0x21,
  KeyG: 0x22,
  KeyH: 0x23,
  KeyJ: 0x24,
  KeyK: 0x25,
  KeyL: 0x26,
  Semicolon: 0x27,
  Quote: 0x28,
  Backquote: 0x29,
  ShiftLeft: 0x2a,
  Backslash: 0x2b,
  KeyZ: 0x2c,
  KeyX: 0x2d,
  KeyC: 0x2e,
  KeyV: 0x2f,
  KeyB: 0x30,
  KeyN: 0x31,
  KeyM: 0x32,
  Comma: 0x33,
  Period: 0x34,
  Slash: 0x35,
  ShiftRight: 0x36,
  NumpadMultiply: 0x37,
  AltLeft: 0x38,
  Space: 0x39,
  CapsLock: 0x3a,
  F1: 0x3b,
  F2: 0x3c,
  F3: 0x3d,
  F4: 0x3e,
  F5: 0x3f,
  F6: 0x40,
  F7: 0x41,
  F8: 0x42,
  F9: 0x43,
  F10: 0x44,
  NumLock: 0x45,
  ScrollLock: 0x46,
  Numpad7: 0x47,
  Numpad8: 0x48,
  Numpad9: 0x49,
  NumpadSubtract: 0x4a,
  Numpad4: 0x4b,
  Numpad5: 0x4c,
  Numpad6: 0x4d,
  NumpadAdd: 0x4e,
  Numpad1: 0x4f,
  Numpad2: 0x50,
  Numpad3: 0x51,
  Numpad0: 0x52,
  NumpadDecimal: 0x53,
  IntlBackslash: 0x56,
  F11: 0x57,
  F12: 0x58,
  NumpadEnter: 0x11c,
  ControlRight: 0x11d,
  NumpadDivide: 0x135,
  AltRight: 0x138,
  Home: 0x147,
  ArrowUp: 0x148,
  PageUp: 0x149,
  ArrowLeft: 0x14b,
  ArrowRight: 0x14d,
  End: 0x14f,
  ArrowDown: 0x150,
  PageDown: 0x151,
  Insert: 0x152,
  Delete: 0x153,
  MetaLeft: 0x15b,
  MetaRight: 0x15c,
  ContextMenu: 0x15d,
};
export function remoteScanCode(
  code: string,
): Key | undefined {
  const value = scanCodes[code];
  return typeof value === "number"
    ? { scanCode: value & 0xff, extended: value > 0xff }
    : undefined;
}
const modifiers = [
  ["ctrlKey", "ControlLeft", "ControlRight"],
  ["altKey", "AltLeft", "AltRight"],
  ["shiftKey", "ShiftLeft", "ShiftRight"],
  ["metaKey", "MetaLeft", "MetaRight"],
] as const;

/** Owned key transitions only. The surface owns focus and authorization lifetimes. */
export class RemoteKeyboard {
  private readonly held = new Map<string, Key>();
  constructor(
    private readonly port: {
      input(event: RemoteKeyEvent): boolean;
      cancel(): void;
    },
    private readonly options: RemoteKeyboardOptions,
  ) {}
  private send(
    code: string,
    key: Key,
    down: boolean,
  ): boolean {
    // Record before sending: backpressure can synchronously reset input ownership.
    if (down) this.held.set(code, key);
    else this.held.delete(code);
    const sent = this.port.input({
      type: "key",
      ...key,
      down,
    });
    if (!sent) this.clear();
    return sent;
  }
  private reconcile(
    event: BrowserKey,
    press: boolean,
  ): boolean {
    for (const [flag, left, right] of modifiers) {
      if (!event[flag]) {
        for (const code of [left, right]) {
          const key = this.held.get(code);
          if (key && !this.send(code, key, false))
            return false;
        }
      } else if (
        press &&
        event.code !== left &&
        event.code !== right &&
        !this.held.has(left) &&
        !this.held.has(right)
      ) {
        // A modifier may already be held when the user focuses the remote surface.
        if (!this.send(left, remoteScanCode(left)!, true))
          return false;
      }
    }
    return true;
  }
  /** Keep the local exit path available even if native capture has stopped. */
  exit(event: BrowserKey): boolean {
    const exitCode =
      this.options.exitShortcut === "ctrl-alt-shift-x"
        ? "KeyX"
        : "KeyQ";
    if (
      event.code === exitCode &&
      event.ctrlKey &&
      event.altKey &&
      event.shiftKey &&
      !event.metaKey
    ) {
      this.clear();
      this.port.cancel();
      return true;
    }
    return false;
  }
  down(event: BrowserKey): boolean {
    if (this.exit(event)) return true;
    if (!this.options.enabled) return false;
    // Local IME composition is handled separately from physical keys, never twice.
    if (event.isComposing || event.key === "Process") {
      this.release();
      return false;
    }
    const key = remoteScanCode(event.code);
    if (!key) return false;
    if (event.repeat && !this.held.has(event.code))
      return true;
    if (!this.reconcile(event, true)) return false;
    if (this.held.has(event.code) && !event.repeat)
      return true;
    return this.send(event.code, key, true);
  }
  up(event: BrowserKey): boolean {
    const key = this.held.get(event.code);
    const sent = key
      ? this.send(event.code, key, false)
      : false;
    this.reconcile(event, false);
    return sent;
  }
  release(): void {
    for (const [code, key] of [...this.held].reverse()) {
      if (!this.send(code, key, false)) break;
    }
    this.clear();
  }
  /** Soft-keyboard modifiers are local latches, held remotely only for this stroke. */
  tap(
    code: string,
    modifiers: readonly string[] = [],
  ): boolean {
    const event: BrowserKey = {
      code,
      key: code,
      repeat: false,
      isComposing: false,
      ctrlKey: modifiers.includes("ControlLeft"),
      altKey: modifiers.includes("AltLeft"),
      shiftKey: modifiers.includes("ShiftLeft"),
      metaKey: modifiers.includes("MetaLeft"),
    };
    const sent = this.down(event);
    this.up(event);
    this.release();
    return sent;
  }
  /** A transport reset already releases native input; never replay old presses. */
  clear(): void {
    this.held.clear();
  }
}
