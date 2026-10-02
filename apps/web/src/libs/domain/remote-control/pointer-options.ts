export type RemotePointerMode = "local" | "capture";
export interface RemotePointerOptions {
  mode: RemotePointerMode;
}
export const defaultRemotePointerOptions: Readonly<RemotePointerOptions> =
  {
    mode: "local",
  };
export function resolveRemotePointerOptions(
  value: unknown,
): RemotePointerOptions {
  return {
    mode:
      value &&
      typeof value === "object" &&
      "mode" in value &&
      value.mode === "capture"
        ? "capture"
        : "local",
  };
}
