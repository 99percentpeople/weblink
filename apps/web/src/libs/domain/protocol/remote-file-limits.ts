/** Limits count file bytes, excluding the bundle manifest and text alternatives. */
export const DEFAULT_REMOTE_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_REMOTE_FILE_BYTES = 512 * 1024 * 1024;
export const REMOTE_CONTENT_BYTES = 64 * 1024 * 1024;
export const REMOTE_MANIFEST_BYTES = 1024 * 1024;

export function validRemoteFileLimit(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_REMOTE_FILE_BYTES
  );
}
export function resolveRemoteFileLimit(
  value: unknown,
): number {
  return validRemoteFileLimit(value)
    ? value
    : DEFAULT_REMOTE_FILE_BYTES;
}
/** A clipboard bundle can also contain text/image alternatives; drop bundles cannot. */
export function remoteBundleLimit(
  fileBytes: number,
  clipboard = true,
): number {
  return (
    fileBytes +
    (clipboard ? REMOTE_CONTENT_BYTES : 0) +
    REMOTE_MANIFEST_BYTES +
    4
  );
}
