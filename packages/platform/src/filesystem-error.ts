export type FileSystemOperation =
  | "stat"
  | "list"
  | "read"
  | "resize"
  | "write"
  | "sync"
  | "move"
  | "remove"
  | "open";

/** An error raised by this device's filesystem, with its original native cause. */
export class LocalFileSystemError extends Error {
  constructor(
    readonly operation: FileSystemOperation,
    readonly path: string,
    cause: unknown,
    readonly range?: {
      offset?: number;
      length?: number;
      size?: number;
    },
  ) {
    const detail =
      typeof cause === "string"
        ? cause
        : typeof cause === "object" &&
            cause !== null &&
            "message" in cause &&
            typeof cause.message === "string"
          ? cause.message
          : String(cause);
    const position = range
      ? ` (${Object.entries(range)
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")})`
      : "";
    super(
      `vfs_${operation}: ${path}${position}: ${detail}`,
      {
        cause,
      },
    );
    this.name = "LocalFileSystemError";
  }
}
