import { invoke } from "@tauri-apps/api/core";
import { createPreviewTrack } from "./preview-track";

/** A bounded, opt-in CPU consumer. It never feeds the native display surface. */
export async function openPresentationRecording(
  id: string,
  sourceClosed: () => boolean,
  signal: AbortSignal,
  ended: (error?: Error) => void,
) {
  signal.throwIfAborted();
  const presenter = createPreviewTrack();
  let closed = false,
    sequence = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void,
    reject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    presenter.close();
    reject(
      new DOMException(
        "Recording source closed",
        "AbortError",
      ),
    );
  };
  const pump = async () => {
    const start = performance.now();
    try {
      if (sourceClosed())
        throw new Error("Native video source ended");
      const data = await invoke<ArrayBuffer>(
        "presentation_frame",
        { id, after: sequence },
      );
      if (closed) return;
      if (data.byteLength) {
        const header = new DataView(data);
        const width = header.getUint32(0, true),
          height = header.getUint32(4, true);
        if (
          width < 2 ||
          height < 2 ||
          width > 3840 ||
          height > 2160 ||
          width % 2 ||
          height % 2 ||
          data.byteLength !== 24 + (width * height * 3) / 2
        )
          throw new Error("Invalid native recording frame");
        sequence = Number(header.getBigUint64(8, true));
        const frame = new VideoFrame(
          new Uint8Array(data, 24),
          {
            format: "NV12",
            codedWidth: width,
            codedHeight: height,
            timestamp: Math.round(performance.now() * 1000),
            colorSpace: {
              matrix: header.getUint8(16)
                ? "bt709"
                : "smpte170m",
              fullRange: !!header.getUint8(17),
            },
          },
        );
        try {
          await presenter.write(frame);
        } finally {
          frame.close();
        }
        resolve();
      }
      if (!closed)
        timer = setTimeout(
          () => void pump(),
          Math.max(
            1,
            1000 / 60 - (performance.now() - start),
          ),
        );
    } catch (error) {
      if (closed) return;
      reject(error);
      close();
      ended(
        error instanceof Error
          ? error
          : new Error(String(error)),
      );
    }
  };
  signal.addEventListener("abort", close, { once: true });
  const deadline = setTimeout(() => {
    reject(new Error("Native recording source timed out"));
    close();
  }, 10000);
  try {
    void pump();
    await ready;
    signal.throwIfAborted();
    return { stream: presenter.stream, close };
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
