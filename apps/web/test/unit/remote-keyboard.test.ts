import { describe, expect, it, vi } from "vitest";
import {
  RemoteKeyboard,
  remoteScanCode,
  type BrowserKey,
  type RemoteKeyEvent,
} from "@/libs/domain/remote-control/keyboard";
import {
  defaultRemoteKeyboardOptions,
  resolveRemoteKeyboardOptions,
} from "@/libs/domain/remote-control/keyboard-options";

const key = (
  code: string,
  patch: Partial<BrowserKey> = {},
): BrowserKey => ({
  code,
  key: code,
  repeat: false,
  isComposing: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...patch,
});
function setup(options = defaultRemoteKeyboardOptions) {
  const input = vi.fn((_event: RemoteKeyEvent) => true),
    cancel = vi.fn();
  const keyboard = new RemoteKeyboard(
    { input, cancel },
    options,
  );
  return {
    keyboard,
    input,
    cancel,
    events: () => input.mock.calls.map(([event]) => event),
  };
}
describe("remote keyboard", () => {
  it("can handle only the local exit without forwarding DOM duplicates of native input", () => {
    const { keyboard, events, cancel } = setup();
    expect(keyboard.exit(key("KeyA"))).toBe(false);
    expect(
      keyboard.exit(
        key("KeyQ", {
          ctrlKey: true,
          altKey: true,
          shiftKey: true,
        }),
      ),
    ).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(events()).toEqual([]);
  });
  it("sends one soft-keyboard chord then releases modifiers, including shortcut cancellation", () => {
    const { keyboard, events, cancel } = setup();
    expect(
      keyboard.tap("KeyC", ["ControlLeft", "ShiftLeft"]),
    ).toBe(true);
    expect(
      events().map((v) => [v.scanCode, v.down]),
    ).toEqual([
      [0x1d, true],
      [0x2a, true],
      [0x2e, true],
      [0x2e, false],
      [0x2a, false],
      [0x1d, false],
    ]);
    expect(
      keyboard.tap("KeyQ", [
        "ControlLeft",
        "AltLeft",
        "ShiftLeft",
      ]),
    ).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(events()).toHaveLength(6);
  });
  it("uses physical positions, distinguishes extended and numpad keys, and rejects unknown codes", () => {
    const { keyboard, events } = setup();
    keyboard.down(key("KeyA", { key: "q" }));
    keyboard.up(key("KeyA", { key: "q" }));
    expect(events()).toEqual([
      {
        type: "key",
        scanCode: 0x1e,
        extended: false,
        down: true,
      },
      {
        type: "key",
        scanCode: 0x1e,
        extended: false,
        down: false,
      },
    ]);
    expect(remoteScanCode("ControlRight")).toEqual({
      scanCode: 0x1d,
      extended: true,
    });
    expect(remoteScanCode("NumpadEnter")).toEqual({
      scanCode: 0x1c,
      extended: true,
    });
    expect(remoteScanCode("ArrowUp")).toEqual({
      scanCode: 0x48,
      extended: true,
    });
    expect(remoteScanCode("Numpad8")).toEqual({
      scanCode: 0x48,
      extended: false,
    });
    for (const code of [
      "Unidentified",
      "Pause",
      "PrintScreen",
      "toString",
      "__proto__",
    ]) {
      expect(keyboard.down(key(code))).toBe(false);
      expect(remoteScanCode(code)).toBeUndefined();
    }
    expect(events()).toHaveLength(2);
  });
  it("forwards repeats only for an owned press and releases each key once", () => {
    const { keyboard, events } = setup();
    keyboard.down(key("KeyA", { repeat: true }));
    expect(events()).toHaveLength(0);
    keyboard.down(key("KeyA"));
    keyboard.down(key("KeyA"));
    keyboard.down(key("KeyA", { repeat: true }));
    keyboard.release();
    keyboard.up(key("KeyA"));
    expect(events().map((event) => event.down)).toEqual([
      true,
      true,
      false,
    ]);
  });
  it("maintains right modifiers and releases keys before modifiers on focus loss", () => {
    const { keyboard, events } = setup();
    keyboard.down(key("ControlRight", { ctrlKey: true }));
    keyboard.down(key("KeyC", { ctrlKey: true }));
    keyboard.release();
    expect(events()).toEqual([
      {
        type: "key",
        scanCode: 0x1d,
        extended: true,
        down: true,
      },
      {
        type: "key",
        scanCode: 0x2e,
        extended: false,
        down: true,
      },
      {
        type: "key",
        scanCode: 0x2e,
        extended: false,
        down: false,
      },
      {
        type: "key",
        scanCode: 0x1d,
        extended: true,
        down: false,
      },
    ]);
  });
  it("reconciles modifiers held before focus and missed modifier releases", () => {
    const { keyboard, events } = setup();
    keyboard.down(key("KeyC", { ctrlKey: true }));
    keyboard.up(key("KeyC"));
    expect(events()).toEqual([
      {
        type: "key",
        scanCode: 0x1d,
        extended: false,
        down: true,
      },
      {
        type: "key",
        scanCode: 0x2e,
        extended: false,
        down: true,
      },
      {
        type: "key",
        scanCode: 0x2e,
        extended: false,
        down: false,
      },
      {
        type: "key",
        scanCode: 0x1d,
        extended: false,
        down: false,
      },
    ]);
  });
  it("allows Escape remotely and consumes only the configured exit chord even when forwarding is off", () => {
    const { keyboard, events, cancel } = setup();
    expect(keyboard.down(key("Escape"))).toBe(true);
    keyboard.up(key("Escape"));
    expect(cancel).not.toHaveBeenCalled();
    expect(events()[0]).toMatchObject({
      scanCode: 0x01,
      down: true,
    });
    const disabled = setup({
      enabled: false,
      systemKeys: true,
      exitShortcut: "ctrl-alt-shift-x",
    });
    const chord = {
      ctrlKey: true,
      altKey: true,
      shiftKey: true,
    };
    expect(disabled.keyboard.down(key("KeyQ", chord))).toBe(
      false,
    );
    expect(
      disabled.keyboard.down(
        key("KeyX", { ...chord, metaKey: true }),
      ),
    ).toBe(false);
    expect(disabled.keyboard.down(key("KeyX", chord))).toBe(
      true,
    );
    expect(disabled.cancel).toHaveBeenCalledOnce();
    expect(disabled.events()).toEqual([]);
    keyboard.down(key("ControlLeft", { ctrlKey: true }));
    keyboard.down(key("KeyQ", chord));
    expect(cancel).toHaveBeenCalledOnce();
    expect(
      events().some((event) => event.scanCode === 0x10),
    ).toBe(false);
    const count = events().length;
    keyboard.up(key("ControlLeft"));
    expect(events()).toHaveLength(count);
  });
  it("releases held input for local composition without sending duplicate physical keys", () => {
    const { keyboard, events } = setup();
    keyboard.down(key("ShiftLeft", { shiftKey: true }));
    expect(
      keyboard.down(
        key("KeyA", { key: "Process", isComposing: true }),
      ),
    ).toBe(false);
    keyboard.up(key("ShiftLeft", { isComposing: true }));
    expect(
      events().map((event) => [event.scanCode, event.down]),
    ).toEqual([
      [0x2a, true],
      [0x2a, false],
    ]);
  });
  it("does not replay presses after an input reset or failed send", () => {
    const { keyboard, events, input } = setup();
    keyboard.down(key("KeyA"));
    keyboard.clear();
    keyboard.down(key("KeyA", { repeat: true }));
    keyboard.up(key("KeyA"));
    expect(events()).toHaveLength(1);
    input.mockReturnValue(false);
    expect(keyboard.down(key("KeyB"))).toBe(false);
    input.mockReturnValue(true);
    keyboard.up(key("KeyB"));
    expect(events()).toHaveLength(2);
  });
  it("normalizes older or malformed saved preferences", () => {
    for (const value of [
      undefined,
      null,
      {},
      { enabled: "false", exitShortcut: "Escape" },
    ])
      expect(resolveRemoteKeyboardOptions(value)).toEqual(
        defaultRemoteKeyboardOptions,
      );
    expect(
      resolveRemoteKeyboardOptions({
        enabled: false,
        exitShortcut: "ctrl-alt-shift-x",
      }),
    ).toEqual({
      enabled: false,
      systemKeys: true,
      exitShortcut: "ctrl-alt-shift-x",
    });
    expect(
      resolveRemoteKeyboardOptions({ systemKeys: false })
        .systemKeys,
    ).toBe(false);
  });
});
