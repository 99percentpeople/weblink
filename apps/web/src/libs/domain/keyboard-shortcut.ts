/** Canonical local shortcut: ctrl-alt-shift-meta-key, with absent modifiers omitted. */
const keys: Readonly<Record<string, string>> = {
  Escape: "Esc",
  Tab: "Tab",
  Enter: "Enter",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};
const codes = [
  ...Array.from(
    { length: 26 },
    (_, i) => `Key${String.fromCharCode(65 + i)}`,
  ),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 11 }, (_, i) => `F${i + 1}`),
  ...Object.keys(keys),
];
const token = (code: string) =>
  code.replace(/^(Key|Digit)/, "").toLowerCase();
const modifiers = ["ctrl", "alt", "shift", "meta"] as const;
export type ShortcutEvent = Pick<
  KeyboardEvent,
  "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
> & { key?: string };
// Letter shortcuts follow the local keyboard layout, as Windows virtual-key hotkeys do.
const shortcutCode = (event: ShortcutEvent): string =>
  event.key && /^[a-z]$/i.test(event.key)
    ? `Key${event.key.toUpperCase()}`
    : event.code;

export function parseShortcut(
  value: unknown,
): ShortcutEvent | undefined {
  if (typeof value !== "string") return;
  const parts = value.split("-");
  const code = codes.find(
    (code) => token(code) === parts.at(-1),
  );
  const flags = modifiers.filter((modifier) =>
    parts.includes(modifier),
  );
  if (
    !code ||
    !flags.some((flag) => flag !== "shift") ||
    [...flags, token(code)].join("-") !== value
  )
    return;
  // OS secure attention and window/task switching cannot be reliably recorded or intercepted.
  if (
    value === "ctrl-alt-delete" ||
    value === "alt-tab" ||
    value === "alt-f4" ||
    value === "meta-l"
  )
    return;
  return {
    code,
    ctrlKey: flags.includes("ctrl"),
    altKey: flags.includes("alt"),
    shiftKey: flags.includes("shift"),
    metaKey: flags.includes("meta"),
  };
}
export function recordShortcut(
  event: ShortcutEvent,
): string | undefined {
  const value = [
    ...modifiers.filter((flag) => event[`${flag}Key`]),
    token(shortcutCode(event)),
  ].join("-");
  return parseShortcut(value) ? value : undefined;
}
export function matchesShortcut(
  value: string,
  event: ShortcutEvent,
): boolean {
  const shortcut = parseShortcut(value);
  return (
    !!shortcut &&
    shortcut.code === shortcutCode(event) &&
    modifiers.every(
      (flag) =>
        shortcut[`${flag}Key`] === event[`${flag}Key`],
    )
  );
}
/** Labels also cover incomplete chords while a shortcut is being recorded. */
export function shortcutKeys(
  event: ShortcutEvent,
): string[] {
  const code = shortcutCode(event);
  return [
    ...modifiers
      .filter((flag) => event[`${flag}Key`])
      .map(
        (flag) =>
          ({
            ctrl: "Ctrl",
            alt: "Alt",
            shift: "Shift",
            meta: "Win / ⌘",
          })[flag],
      ),
    ...(code &&
    !/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(code)
      ? [keys[code] ?? code.replace(/^(Key|Digit)/, "")]
      : []),
  ];
}
export function shortcutLabel(value: string): string {
  const shortcut = parseShortcut(value);
  return shortcut
    ? shortcutKeys(shortcut).join(" + ")
    : value;
}
