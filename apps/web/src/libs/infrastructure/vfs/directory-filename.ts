import { DirectoryWriteError } from "@/libs/domain/vfs";

// Reserved for browser-directory storage; no separate filename index is needed.
const suffix = ".weblink";

export function encodeDirectoryFilename(
  name: string,
): string {
  return `${name}${suffix}`;
}

/** Decode exactly one layer; an imported name matching this format is escaped again. */
export function decodeDirectoryFilename(
  name: string,
): string {
  return name.endsWith(suffix) &&
    name.length > suffix.length
    ? name.slice(0, -suffix.length)
    : name;
}

/** Only filename rejection qualifies; permissions, write and commit failures do not. */
export function isDirectoryNameBlocked(
  error: unknown,
): boolean {
  if (error instanceof DirectoryWriteError) {
    if (error.stage !== "create") return false;
    error = error.cause;
  }
  const cause = error as
    | { name?: unknown; message?: unknown }
    | null
    | undefined;
  return (
    cause?.name === "TypeError" &&
    typeof cause.message === "string" &&
    /Name is not allowed/i.test(cause.message)
  );
}
