export const exitControlShortcuts = [
  "ctrl-alt-shift-q",
  "ctrl-alt-shift-x",
] as const;
export type ExitControlShortcut =
  (typeof exitControlShortcuts)[number];
export interface RemoteKeyboardOptions {
  enabled: boolean;
  systemKeys: boolean;
  exitShortcut: ExitControlShortcut;
}
export const defaultRemoteKeyboardOptions: Readonly<RemoteKeyboardOptions> =
  {
    enabled: true,
    systemKeys: true,
    exitShortcut: "ctrl-alt-shift-q",
  };
export function resolveRemoteKeyboardOptions(
  value: unknown,
): RemoteKeyboardOptions {
  const v =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  return {
    enabled:
      typeof v.enabled === "boolean" ? v.enabled : true,
    systemKeys:
      typeof v.systemKeys === "boolean"
        ? v.systemKeys
        : true,
    exitShortcut:
      v.exitShortcut === "ctrl-alt-shift-x"
        ? v.exitShortcut
        : "ctrl-alt-shift-q",
  };
}
export function exitControlShortcutLabel(
  shortcut: ExitControlShortcut,
): string {
  return shortcut === "ctrl-alt-shift-x"
    ? "Ctrl+Alt+Shift+X"
    : "Ctrl+Alt+Shift+Q";
}
