/** The common lifecycle shared by MediaRecorder and encoded sender recording. */
export interface RecordingEngine extends EventTarget {
  readonly state: RecordingState;
  readonly mimeType: string;
  start(timeslice?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
  /** A muxer that supplies its own duration/seek index patches bypasses header rewriting. */
  getPatches?(): readonly VfsWrite[];
  dispose?(): Promise<void>;
}
import type { VfsWrite } from "@weblink/platform";
