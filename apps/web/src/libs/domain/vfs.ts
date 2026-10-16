export type {
  VfsVolume,
  VfsVolumeInfo,
  VfsStat,
  VfsEntry,
  VfsWrite,
  StoredFile,
  BinarySource,
} from "@weblink/platform";

export class StorageUnavailableError extends Error {
  readonly missing: boolean;
  constructor(
    message = "Storage is unavailable; reconnect or authorize the directory",
    options?: ErrorOptions & { missing?: boolean },
  ) {
    super(message, options);
    this.name = "StorageUnavailableError";
    this.missing = options?.missing ?? false;
  }
}

/** Preserve the browser's actual failure and stage instead of calling every AbortError a cancellation. */
export class DirectoryWriteError extends Error {
  constructor(
    readonly fileName: string,
    readonly stage: "create" | "write" | "commit",
    cause: unknown,
  ) {
    super(`Directory file ${stage} failed: ${fileName}`, {
      cause,
    });
    this.name = "DirectoryWriteError";
  }
  get detail(): string | undefined {
    // DOMException is not an Error in every browser/realm.
    const cause = this.cause as
      | { name?: unknown; message?: unknown }
      | undefined;
    if (!cause || typeof cause.message !== "string") return;
    return typeof cause.name === "string"
      ? `${cause.name}: ${cause.message}`
      : cause.message;
  }
}

/** Every provider accepts only paths relative to its authorized root. */
export function vfsPath(path: string): string {
  if (path === "") return path;
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes(":"),
      )
  )
    throw new Error("Invalid storage path");
  return path;
}

export function storageFilename(name: string): string {
  const safe = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/[. ]+$/, "")
    .slice(0, 120);
  return !safe ||
    /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(safe)
    ? `file_${safe}`
    : safe;
}
