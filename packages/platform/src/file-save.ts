import type { StoredFile } from "./filesystem";
import type {
  FileConflictAction,
  FileConflictResolver,
  FileSaveConflict,
} from "./index";

export interface FileSaveProgress {
  /** One-based index; zero while waiting for a destination. */
  fileIndex: number;
  fileName: string;
  fileSize: number;
  /** Bytes written to the current transaction, not yet necessarily committed. */
  fileBytesWritten: number;
  totalFiles: number;
  /** Counts only files whose final commit succeeded. */
  savedFiles: number;
  skippedFiles: number;
  totalBytes: number;
  /** Saved and skipped file sizes, plus the current transaction's written bytes. */
  processedBytes: number;
}

export interface FileBatchSaveOptions {
  signal?: AbortSignal;
  onProgress?: (progress: FileSaveProgress) => void;
}

export type FileSaveOutcome =
  | "saved"
  | "skipped"
  | "cancelled";

export function createFileSaveProgress(
  files: readonly StoredFile[],
): FileSaveProgress {
  return {
    fileIndex: 0,
    fileName: "",
    fileSize: 0,
    fileBytesWritten: 0,
    totalFiles: files.length,
    savedFiles: 0,
    skippedFiles: 0,
    totalBytes: files.reduce(
      (sum, file) => sum + file.size,
      0,
    ),
    processedBytes: 0,
  };
}

/** Both exporters share committed-file accounting and cancellation semantics. */
export async function runFileSaveBatch(
  files: readonly StoredFile[],
  save: (
    file: StoredFile,
    onWritten: (bytes: number) => void,
  ) => Promise<FileSaveOutcome>,
  options: FileBatchSaveOptions = {},
): Promise<boolean> {
  let progress = createFileSaveProgress(files);
  let finishedBytes = 0;
  const report = (patch: Partial<FileSaveProgress>) => {
    progress = { ...progress, ...patch };
    options.onProgress?.(progress);
  };
  try {
    for (const [index, file] of files.entries()) {
      options.signal?.throwIfAborted();
      report({
        fileIndex: index + 1,
        fileName: file.name,
        fileSize: file.size,
        fileBytesWritten: 0,
      });
      const result = await save(file, (bytes) => {
        report({
          fileBytesWritten: bytes,
          processedBytes: finishedBytes + bytes,
        });
      });
      if (result === "cancelled") return false;
      finishedBytes += file.size;
      report({
        savedFiles:
          progress.savedFiles +
          (result === "saved" ? 1 : 0),
        skippedFiles:
          progress.skippedFiles +
          (result === "skipped" ? 1 : 0),
        processedBytes: finishedBytes,
      });
    }
    return true;
  } catch (error) {
    // Uncommitted bytes have been discarded by the exporter.
    report({
      fileBytesWritten: 0,
      processedBytes: finishedBytes,
    });
    if (
      options.signal?.aborted &&
      error === options.signal.reason
    )
      return false;
    throw error;
  }
}

/** Cancellation must release the batch even if a conflict resolver is still pending. */
export async function resolveFileSaveConflict(
  resolve: FileConflictResolver,
  conflict: FileSaveConflict,
  signal?: AbortSignal,
): Promise<FileConflictAction | null> {
  signal?.throwIfAborted();
  if (!signal) return resolve(conflict);
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([
      resolve(conflict),
      cancelled,
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
