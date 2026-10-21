/** Rejects this receiver's selected format, unlike an interrupted transport. */
export class ScreenDecodeError extends Error {
  constructor(
    message = "This receiver cannot decode the selected screen video format.",
  ) {
    super(message);
    this.name = "ScreenDecodeError";
  }
}

/** RTP kept arriving without decoded progress; a new keyframe may recover it. */
export class ScreenDecodeStallError extends Error {
  constructor() {
    super(
      "Native screen video decoding stalled while receiving data",
    );
    this.name = "ScreenDecodeStallError";
  }
}

export interface NativeScreenView {
  sourceId: string;
  stream?: MediaStream;
  error?: "codec" | "connection";
}
