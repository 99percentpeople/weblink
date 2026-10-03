/** Terminal for this publication/receiver, unlike an interrupted transport. */
export class ScreenDecodeError extends Error {
  constructor(
    message = "This receiver cannot decode the selected screen video format.",
  ) {
    super(message);
    this.name = "ScreenDecodeError";
  }
}

export interface NativeScreenView {
  sourceId: string;
  stream?: MediaStream;
  error?: "codec" | "connection";
}
