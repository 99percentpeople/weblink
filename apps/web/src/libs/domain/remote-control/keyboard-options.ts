import { parseShortcut } from "../keyboard-shortcut";

export type ExitControlShortcut = string;
export type ClipboardFileDestination =
  | "clipboard"
  | "cache"
  | "off";
export interface RemoteKeyboardOptions {
  enabled: boolean;
  autoShow: boolean;
  collapseControls: boolean;
  clipboard: boolean;
  /** Unset until the app resolves the first default from clipboard capabilities. */
  clipboardFiles?: ClipboardFileDestination;
  systemKeys: boolean;
  exitShortcut: ExitControlShortcut;
  emergencyShortcut: string;
}
export const defaultRemoteKeyboardOptions: Readonly<RemoteKeyboardOptions> =
  {
    enabled: true,
    autoShow: false,
    collapseControls: false,
    clipboard: false,
    clipboardFiles: undefined,
    systemKeys: true,
    exitShortcut: "ctrl-alt-shift-q",
    emergencyShortcut: "ctrl-alt-shift-f10",
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
    autoShow: v.autoShow === true,
    collapseControls: v.collapseControls === true,
    clipboard: v.clipboard === true,
    clipboardFiles:
      v.clipboardFiles === "clipboard" ||
      v.clipboardFiles === "cache" ||
      v.clipboardFiles === "off"
        ? v.clipboardFiles
        : undefined,
    systemKeys:
      typeof v.systemKeys === "boolean"
        ? v.systemKeys
        : true,
    exitShortcut: parseShortcut(v.exitShortcut)
      ? (v.exitShortcut as string)
      : defaultRemoteKeyboardOptions.exitShortcut,
    emergencyShortcut: parseShortcut(v.emergencyShortcut)
      ? (v.emergencyShortcut as string)
      : defaultRemoteKeyboardOptions.emergencyShortcut,
  };
}
