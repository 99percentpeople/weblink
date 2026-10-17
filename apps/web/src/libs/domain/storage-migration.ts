export interface StorageMigrationProgress {
  phase:
    | "preparing"
    | "copying"
    | "verifying"
    | "waiting"
    | "deleting"
    | "completed"
    | "failed";
  fileName: string;
  totalFiles: number;
  completedFiles: number;
  bytes: number;
  totalBytes: number;
  failures: readonly {
    id: string;
    fileName: string;
    error: string;
  }[];
}
