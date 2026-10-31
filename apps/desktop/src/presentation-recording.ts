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
  const recordingId = crypto.randomUUID();
  let closed = false,
    opened = false,
    released = false,
    started = false,
    sequence = 0;
  let starting: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: () => void,
    reject!: (error: unknown) => void;
  const ready = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  const release = () => {
    if (!opened || released) return;
    released = true;
    void invoke("presentation_recording_close", {
      id,
      recordingId,
    }).catch(() => {});
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", close);
    presenter.close();
    release();
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
        { id, recordingId, after: sequence },
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
      } else {
        // A generated track does not retain a frame for later consumers. Keep
        // static recordings alive using the retained pixels, without a GPU copy.
        await presenter.refresh();
      }
      if (!closed && (sequence === 0 || started))
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
    // If cancelled while opening, wait for the acknowledgement before closing
    // the native session so the close cannot overtake its creation.
    void invoke("presentation_recording_open", {
      id,
      recordingId,
    }).then(
      () => {
        opened = true;
        if (closed) release();
        else void pump();
      },
      (error: unknown) => {
        if (!closed) {
          reject(error);
          close();
        }
      },
    );
    await ready;
    signal.throwIfAborted();
    return {
      stream: presenter.stream,
      close,
      start: () =>
        (starting ??= (async () => {
          if (closed)
            throw new DOMException(
              "Recording source closed",
              "AbortError",
            );
          // The first native read prepares dimensions/pixels before MediaRecorder
          // exists. Replay only after it attaches, including very short recordings.
          await presenter.refresh(true);
          if (closed) return;
          started = true;
          void pump();
        })()),
    };
  } catch (error) {
    close();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
