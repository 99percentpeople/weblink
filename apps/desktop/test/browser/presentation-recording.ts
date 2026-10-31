import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { openPresentationRecording } from "../../src/presentation-recording";

/** Only the native IPC boundary is simulated; VideoFrames and track delivery are real. */
export async function staticRecordingInput(
  canvas: boolean,
) {
  const runtime = globalThis as unknown as {
    MediaStreamTrackGenerator: unknown;
  };
  const generator = runtime.MediaStreamTrackGenerator;
  if (!canvas && !generator)
    throw new Error(
      "Generated tracks unavailable on this test host",
    );
  if (canvas) runtime.MediaStreamTrackGenerator = undefined;
  const bytes = new ArrayBuffer(24 + (160 * 90 * 3) / 2);
  const header = new DataView(bytes);
  header.setUint32(0, 160, true);
  header.setUint32(4, 90, true);
  header.setBigUint64(8, 1n, true);
  header.setUint8(16, 1);
  new Uint8Array(bytes, 24, 160 * 90).fill(90);
  new Uint8Array(bytes, 24 + 160 * 90).fill(128);
  let copies = 0,
    closes = 0;
  const errors: unknown[] = [];
  mockIPC((command, args) => {
    if (command === "presentation_recording_close")
      closes++;
    if (command !== "presentation_frame") return;
    if (!args || !("after" in args) || args.after !== 0)
      return new ArrayBuffer(0);
    copies++;
    return bytes.slice(0);
  });
  try {
    const input = await openPresentationRecording(
      "static",
      () => false,
      new AbortController().signal,
      (error) => errors.push(error),
    );
    return {
      ...input,
      copies: () => copies,
      closes: () => closes,
      errors,
      dispose() {
        input.close();
        clearMocks();
        runtime.MediaStreamTrackGenerator = generator;
      },
    };
  } catch (error) {
    clearMocks();
    runtime.MediaStreamTrackGenerator = generator;
    throw error;
  }
}
