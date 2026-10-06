export type RemotePointerMode = "local" | "capture";
export interface RemotePointerOptions {
  mode: RemotePointerMode;
  syncCursor: boolean;
  fileDrop: boolean;
}
export const defaultRemotePointerOptions: Readonly<RemotePointerOptions> =
  {
    mode: "local",
    syncCursor: true,
    fileDrop: false,
  };
export function resolveRemotePointerOptions(
  value: unknown,
): RemotePointerOptions {
  return {
    fileDrop: !!(
      value &&
      typeof value === "object" &&
      "fileDrop" in value &&
      value.fileDrop === true
    ),
    syncCursor: !(
      value &&
      typeof value === "object" &&
      "syncCursor" in value &&
      value.syncCursor === false
    ),
    mode:
      value &&
      typeof value === "object" &&
      "mode" in value &&
      value.mode === "capture"
        ? "capture"
        : "local",
  };
}
