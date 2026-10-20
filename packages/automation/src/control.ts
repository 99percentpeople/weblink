export interface WindowBindingArguments {
  target: string;
  /** A top-level elementId from accessibility.windows for this caller. */
  windowId: string;
}
export interface WindowBindingResult {
  bound: true;
  windowId: string;
  focusPolicy: "stopOnBlur";
}
export type JobStatus =
  | "running"
  | "completed"
  | "cancelled"
  | "timed_out";
export type JobReadArguments = {
  target: string;
  jobId: string;
} & (
  | {
      cursor?: number;
      tailBytes?: never;
      tailLines?: never;
    }
  | { cursor?: never; tailBytes: number; tailLines?: never }
  | { cursor?: never; tailBytes?: never; tailLines: number }
);
export interface JobOutputPage {
  chunks: {
    stream: "stdout" | "stderr";
    /** Lossy UTF-8 display text. Use dataBase64 for exact or incremental decoding. */
    data: string;
    dataBase64: string;
  }[];
  /** Actual absolute start of this page in the combined stream. */
  startCursor: number;
  /** Absolute byte offset across both streams; pass unchanged to the next read. */
  nextCursor: number;
  /** More buffered bytes right now. False does not imply process completion. */
  hasMore: boolean;
  /** Cumulative bytes observed, including evicted output. */
  bytes: number;
  retainedBytes: number;
  /** Earliest absolute byte offset still available in the rolling buffer. */
  earliestCursor: number;
  /** Old output was evicted; distinct from intentionally selecting a tail. */
  truncated: boolean;
  /** The supplied cursor was evicted; this page resumes at earliestCursor. */
  cursorExpired: boolean;
  /** Requested tail lines exceeded the 16 KiB response cap. */
  tailLimited: boolean;
  /** A pipe failed or output draining timed out; terminal status waits for reader cleanup. */
  outputIncomplete: boolean;
  status: JobStatus;
  exitCode: number | null;
}
