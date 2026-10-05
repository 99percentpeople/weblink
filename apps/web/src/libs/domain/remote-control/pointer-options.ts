export type RemotePointerMode = "local" | "capture";
export interface RemotePointerOptions {
  mode: RemotePointerMode;
  syncCursor: boolean;
}
export const defaultRemotePointerOptions: Readonly<RemotePointerOptions> =
  {
    mode: "local",
    syncCursor: true,
  };
export function resolveRemotePointerOptions(
  value: unknown,
): RemotePointerOptions {
  return {
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
