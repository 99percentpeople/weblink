import {
  MAX_REMOTE_FILE_BYTES,
  REMOTE_CONTENT_BYTES,
  REMOTE_MANIFEST_BYTES,
  remoteBundleLimit,
  resolveRemoteFileLimit,
  validRemoteFileLimit,
} from "./remote-file-limits";
export const CLIPBOARD_MAX_BYTES = remoteBundleLimit(
  MAX_REMOTE_FILE_BYTES,
);
export const CLIPBOARD_MAX_ENTRIES = 4096;
export const CLIPBOARD_CHUNK_SIZE = 128 * 1024;
export const CLIPBOARD_INLINE_BYTES = 8 * 1024;
export type ClipboardContentKind = "text" | "binary";
export const CLIPBOARD_FORMATS = [
  "text/plain",
  "text/html",
  "text/rtf",
  "image/png",
] as const;
export type ClipboardFormat =
  (typeof CLIPBOARD_FORMATS)[number];
export type InlineClipboardEntry = {
  type: Exclude<ClipboardFormat, "image/png">;
  data: string;
};
export function validInlineClipboard(
  value: unknown,
): value is InlineClipboardEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 3 &&
    value.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        ["text/plain", "text/html", "text/rtf"].includes(
          entry.type,
        ) &&
        typeof entry.data === "string",
    ) &&
    new Set(value.map((entry) => entry.type)).size ===
      value.length &&
    new TextEncoder().encode(JSON.stringify(value))
      .byteLength <= CLIPBOARD_INLINE_BYTES
  );
}
export type ClipboardRequest = {
  grantId: string;
  operationId: string;
  action:
    | "prepare"
    | "read"
    | "read-current"
    | "offer"
    | "inline"
    | "watch"
    | "unwatch"
    | "changed";
  /** Only offers have these fields. */
  direction?: "copy" | "paste";
  size?: number;
  kind?: ClipboardContentKind;
  entries?: InlineClipboardEntry[];
  /** Read requests may exclude files/directories before native file access. */
  files?: boolean;
  /** Accepted non-file formats. Omission keeps all formats for older/native clients. */
  formats?: ClipboardFormat[];
  /** Controller-selected file budget, fixed when an operation starts. */
  maxFileBytes?: number;
};
export function validClipboardRequest(
  v: Record<string, unknown>,
): boolean {
  const id = (s: unknown) =>
    typeof s === "string" &&
    /^[a-zA-Z0-9-]{1,128}$/.test(s);
  if (!id(v.grantId) || !id(v.operationId)) return false;
  if (v.action === "inline")
    return (
      (v.direction === "copy" || v.direction === "paste") &&
      validInlineClipboard(v.entries) &&
      v.size === undefined &&
      v.kind === undefined &&
      v.files === undefined &&
      v.formats === undefined &&
      v.maxFileBytes === undefined
    );
  if (v.entries !== undefined) return false;
  if (
    v.maxFileBytes !== undefined &&
    (!validRemoteFileLimit(v.maxFileBytes) ||
      !(
        v.action === "prepare" ||
        v.action === "read-current" ||
        (v.action === "offer" && v.direction === "paste")
      ))
  )
    return false;
  if (
    v.files !== undefined &&
    (!(
      v.action === "read" || v.action === "read-current"
    ) ||
      typeof v.files !== "boolean")
  )
    return false;
  if (
    v.formats !== undefined &&
    (!(
      v.action === "read" || v.action === "read-current"
    ) ||
      !Array.isArray(v.formats) ||
      v.formats.length > CLIPBOARD_FORMATS.length ||
      new Set(v.formats).size !== v.formats.length ||
      !v.formats.every((format) =>
        CLIPBOARD_FORMATS.includes(format),
      ))
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
    (v.size as number) <=
      (v.kind === "text"
        ? REMOTE_CONTENT_BYTES + REMOTE_MANIFEST_BYTES + 4
        : v.direction === "paste"
          ? remoteBundleLimit(
              resolveRemoteFileLimit(v.maxFileBytes),
            )
          : CLIPBOARD_MAX_BYTES)
  );
}
