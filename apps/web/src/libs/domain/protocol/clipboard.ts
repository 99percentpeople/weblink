export const CLIPBOARD_MAX_BYTES = 64 * 1024 * 1024;
export const CLIPBOARD_MAX_ENTRIES = 4096;
export const CLIPBOARD_CHUNK_SIZE = 128 * 1024;
export type ClipboardContentKind = "text" | "binary";
export type ClipboardRequest = {
  grantId: string;
  operationId: string;
  action:
    | "prepare"
    | "read"
    | "read-current"
    | "offer"
    | "watch"
    | "unwatch"
    | "changed";
  /** Only offers have these fields. */
  direction?: "copy" | "paste";
  size?: number;
  kind?: ClipboardContentKind;
  /** Read requests may exclude files/directories before native file access. */
  files?: boolean;
};
export function validClipboardRequest(
  v: Record<string, unknown>,
): boolean {
  const id = (s: unknown) =>
    typeof s === "string" &&
    /^[a-zA-Z0-9-]{1,128}$/.test(s);
  if (!id(v.grantId) || !id(v.operationId)) return false;
  if (
    v.files !== undefined &&
    (!(
      v.action === "read" || v.action === "read-current"
    ) ||
      typeof v.files !== "boolean")
  )
    return false;
  if (
    [
      "prepare",
      "read",
      "read-current",
      "watch",
      "unwatch",
      "changed",
    ].includes(v.action as string)
  )
    return (
      v.direction === undefined &&
      v.size === undefined &&
      v.kind === undefined
    );
  return (
    v.action === "offer" &&
    (v.direction === "copy" || v.direction === "paste") &&
    (v.kind === "text" || v.kind === "binary") &&
    Number.isSafeInteger(v.size) &&
    (v.size as number) > 4 &&
    (v.size as number) <= CLIPBOARD_MAX_BYTES
  );
}
