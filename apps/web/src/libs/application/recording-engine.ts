import type { VfsWrite } from "@weblink/platform";
import { recordingVideoBitrate } from "./recording-options";

/** The common lifecycle shared by MediaRecorder and encoded packet recording. */
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

export function createBrowserRecorder(
  Constructor: typeof MediaRecorder,
  stream: MediaStream,
  rawLocalCapture: boolean,
): MediaRecorder {
  const videoBitsPerSecond = recordingVideoBitrate(
    stream.getVideoTracks()[0]?.getSettings?.(),
  );
  let cause: unknown = new Error(
    "No supported recording format",
  );
  for (const mimeType of [
    // Local pixels need an encoder. Leave received streams on automatic MIME
    // selection so Chromium can pass through the existing encoded video.
    ...(rawLocalCapture ? ["video/x-matroska"] : []),
    undefined,
    stream.getAudioTracks().length
      ? "video/webm;codecs=vp8,opus"
      : "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ]) {
    if (mimeType && !Constructor.isTypeSupported(mimeType))
      continue;
    try {
      return new Constructor(stream, {
        ...(mimeType ? { mimeType } : {}),
        videoBitsPerSecond,
      });
    } catch (error) {
      cause = error;
    }
  }
  throw cause;
}
