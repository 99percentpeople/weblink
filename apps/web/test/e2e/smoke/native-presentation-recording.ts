import { staticRecordingInput } from "../../../../desktop/test/browser/presentation-recording";
import { idlePresentation } from "../../../../desktop/test/browser/presentation-idle";
import { remuxRecording } from "@/libs/application/recording-remux";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
async function run() {
  const measurements: unknown[] = [
    await idlePresentation(),
  ];
  // Include quick stop, delayed attachment, static content and a second recording.
  for (const canvas of [false, true])
    for (const duration of [100, 2200]) {
      const source = await staticRecordingInput(canvas);
      const errors: unknown[] = [],
        chunks: Blob[] = [];
      const recorder = remuxRecording(
        new MediaRecorder(source.stream),
        "mkv",
      );
      recorder.addEventListener("error", (event) =>
        errors.push(
          (event as Event & { error: unknown }).error,
        ),
      );
      recorder.addEventListener("dataavailable", (event) =>
        chunks.push((event as BlobEvent).data),
      );
      const stopped = new Promise<void>((resolve) =>
        recorder.addEventListener("stop", () => resolve(), {
          once: true,
        }),
      );
      try {
        // The only native frame arrived before MediaRecorder was attached.
        await sleep(100);
        recorder.start(500);
        await source.start();
        await sleep(duration);
        recorder.stop();
        await stopped;
        assert(
          !errors.length && !source.errors.length,
          `Recording failed: ${errors}, ${source.errors}`,
        );
        const bytes = new Uint8Array(
          await new Blob(chunks).arrayBuffer(),
        );
        for (const patch of recorder.getPatches!())
          bytes.set(patch.data, patch.offset);
        const input = new Input({
          formats: ALL_FORMATS,
          source: new BufferSource(bytes),
        });
        try {
          const track = await input.getPrimaryVideoTrack();
          assert(
            track?.codec === "vp8",
            "Static recording has no VP8 video",
          );
          const packet = await new EncodedPacketSink(
            track,
          ).getFirstPacket();
          assert(
            packet?.data.length,
            "Static recording contains no encoded frame",
          );
          const recordedDuration =
            await input.computeDuration();
          assert(
            duration < 1000 || recordedDuration > 1.5,
            "Static frame refresh lost recording duration",
          );
          assert(
            source.copies() === 1,
            "Static refresh requested another native pixel copy",
          );
          assert(
            source.reads() <= 2 + Math.ceil(duration / 500),
            "Static recording kept polling native pixels",
          );
          measurements.push({
            canvas,
            duration,
            recordedDuration,
            bytes: bytes.length,
            nativeCopies: source.copies(),
            nativeReads: source.reads(),
          });
        } finally {
          input.dispose();
        }
      } finally {
        await recorder.dispose?.();
        source.dispose();
        assert(
          source.closes() === 1,
          "Recording leaked or double-closed its native session",
        );
      }
    }
  window.__SPEED_TEST_REPORT__ = {
    ok: true,
    tests: measurements.length,
    passed: [
      "native presentation sleeps at rest and follows WAAPI, reattachment and source resize without a black-frame timer",
      "static native frames survive delayed recorder attachment, quick stop and restart without extra GPU readback",
    ],
    measurements,
  };
}
run().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
