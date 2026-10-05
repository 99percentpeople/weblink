import { expect, it } from "vitest";
import {
  matchesShortcut,
  parseShortcut,
  recordShortcut,
  shortcutLabel,
} from "@/libs/domain/keyboard-shortcut";
import { RemoteKeyboard } from "@/libs/domain/remote-control/keyboard";
import {
  defaultRemoteKeyboardOptions,
  resolveRemoteKeyboardOptions,
} from "@/libs/domain/remote-control/keyboard-options";

it("round trips supported modifiers, navigation, letters, digits and function keys", () => {
  for (const value of [
    "ctrl-shift-arrowup",
    "alt-f8",
    "meta-q",
    "ctrl-alt-9",
    "ctrl-shift-enter",
  ]) {
    expect(recordShortcut(parseShortcut(value)!)).toBe(
      value,
    );
    expect(
      matchesShortcut(value, parseShortcut(value)!),
    ).toBe(true);
    expect(
      matchesShortcut(value, {
        ...parseShortcut(value)!,
        shiftKey: !parseShortcut(value)!.shiftKey,
      }),
    ).toBe(false);
  }
  expect(shortcutLabel("ctrl-shift-arrowup")).toBe(
    "Ctrl + Shift + ↑",
  );
});
it("rejects malformed and reserved chords and normalizes saved host preferences", () => {
  for (const value of [
    null,
    {},
    "q",
    "shift-q",
    "ctrl-ctrl-q",
    "alt-ctrl-q",
    "ctrl-f12",
    "ctrl-f01",
    "ctrl-alt-delete",
    "alt-tab",
    "alt-f4",
    "meta-l",
    "ctrl-unknown",
  ])
    expect(parseShortcut(value)).toBeUndefined();
  expect(
    resolveRemoteKeyboardOptions({
      emergencyShortcut: "ctrl-alt-delete",
    }).emergencyShortcut,
  ).toBe(defaultRemoteKeyboardOptions.emergencyShortcut);
  expect(
    resolveRemoteKeyboardOptions({
      emergencyShortcut: "ctrl-shift-f8",
    }).emergencyShortcut,
  ).toBe("ctrl-shift-f8");
});
it("releases local control using a custom chord even with keyboard forwarding off", () => {
  let cancelled = 0;
  const keyboard = new RemoteKeyboard(
    {
      input: () => {
        throw new Error("must remain local");
      },
      cancel: () => cancelled++,
    },
    {
      ...defaultRemoteKeyboardOptions,
      enabled: false,
      exitShortcut: "ctrl-shift-arrowup",
    },
  );
  expect(
    keyboard.down({
      ...parseShortcut("ctrl-shift-arrowup")!,
      key: "ArrowUp",
      repeat: false,
      isComposing: false,
    }),
  ).toBe(true);
  expect(cancelled).toBe(1);
});

it("records and matches layout letters consistently with native virtual-key shortcuts", () => {
  const event = {
    code: "KeyY",
    key: "z",
    ctrlKey: true,
    altKey: false,
    shiftKey: false,
    metaKey: false,
  };
  expect(recordShortcut(event)).toBe("ctrl-z");
  expect(matchesShortcut("ctrl-z", event)).toBe(true);
  expect(matchesShortcut("ctrl-y", event)).toBe(false);
});
