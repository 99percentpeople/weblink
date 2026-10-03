import { invoke } from "@tauri-apps/api/core";
import type { NativeScreenPreview } from "@weblink/platform";
import { createPreviewTrack } from "./preview-track";

interface SharedBufferEvent {
  additionalData?: { kind?: string; id?: string };
  getBuffer(): ArrayBuffer;
}
interface SharedWebview {
  addEventListener(
    type: "sharedbufferreceived",
    listener: (event: SharedBufferEvent) => void,
  ): void;
  removeEventListener(
    type: "sharedbufferreceived",
    listener: (event: SharedBufferEvent) => void,
  ): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}
interface Frame {
  sequence: number;
  width: number;
  height: number;
  colorSpace?: VideoColorSpaceInit;
}

/** One request at a time is the ownership handshake: Rust must not overwrite the
 * read-only shared buffer until VideoFrame has copied its previous contents.
 * Only small metadata crosses invoke. Pixels never use JSON, events or RTP. */
export async function createRawPreview(
  sessionId: string,
  audio: boolean,
  onEnded: () => void,
  signal?: AbortSignal,
): Promise<NativeScreenPreview> {
  signal?.throwIfAborted();
  const webview = (
    window as Window & {
      chrome?: { webview?: SharedWebview };
    }
  ).chrome?.webview;
  if (
    !webview?.releaseBuffer ||
    typeof VideoFrame === "undefined"
  )
    throw new Error(
      "This WebView2 runtime does not support raw screen preview",
    );
  const id = crypto.randomUUID();
  const presenter = createPreviewTrack();
  const stream = presenter.stream;
  // Local system audio must not echo. This silent, never-published track carries
  // consent/mute/lifetime through the existing shared-audio controls. WASAPI and
  // the actual remote audio track remain entirely native.
  let audioContext: AudioContext | undefined;
  let buffer: ArrayBuffer | undefined;
  let sequence = 0;
  let frames = 0;
  let width = 0;
  let height = 0;
  let closed = false;
  let opening: Promise<unknown> | undefined;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let raf: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let resolveBuffer!: () => void;
  let rejectBuffer!: (error: unknown) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveBuffer = resolve;
    rejectBuffer = reject;
  });
  const receive = (event: SharedBufferEvent) => {
    if (
      event.additionalData?.kind !== "weblink-preview" ||
      event.additionalData.id !== id
    )
      return;
    const incoming = event.getBuffer();
    if (closed) {
      webview.releaseBuffer(incoming);
      return;
    }
    if (buffer) webview.releaseBuffer(buffer);
    buffer = incoming;
    resolveBuffer();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearTimeout(timeout);
    if (raf !== undefined) cancelAnimationFrame(raf);
    signal?.removeEventListener("abort", aborted);
    document.removeEventListener(
      "visibilitychange",
      schedule,
    );
    presenter.close();
    for (const track of stream.getAudioTracks())
      track.stop();
    void audioContext?.close().catch(console.error);
    if (buffer) {
      webview.releaseBuffer(buffer);
      buffer = undefined;
    }
    // Keep the listener until native close is acknowledged, so a late opening
    // event releases its mapping instead of leaking it after abort/navigation.
    void (opening ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        invoke("capture_preview_close", { previewId: id }),
      )
      .catch(console.error)
      .finally(() =>
        webview.removeEventListener(
          "sharedbufferreceived",
          receive,
        ),
      );
  };
  const aborted = () => {
    rejectBuffer(
      signal?.reason ?? new Error("Preview aborted"),
    );
    close();
  };
  const draw = async () => {
    const frame = await invoke<Frame | null>(
      "capture_preview_frame",
      { previewId: id, after: sequence },
    );
    if (closed || !buffer) return false;
    if (!frame) {
      if (await presenter.refresh()) frames++;
      return false;
    }
    if (
      !Number.isInteger(frame.width) ||
      !Number.isInteger(frame.height) ||
      frame.width < 2 ||
      frame.width > 3840 ||
      frame.height < 2 ||
      frame.height > 2160 ||
      frame.width % 2 ||
      frame.height % 2
    )
      throw new Error("Invalid native preview frame");
    const pixels = new VideoFrame(buffer, {
      format: "I420",
      codedWidth: frame.width,
      codedHeight: frame.height,
      timestamp: Math.round(performance.now() * 1000),
      colorSpace: frame.colorSpace ?? {
        matrix: "smpte170m",
        primaries: "bt709",
        transfer: "iec61966-2-1",
        fullRange: false,
      },
    });
    try {
      await presenter.write(pixels);
    } finally {
      pixels.close();
    }
    sequence = frame.sequence;
    width = frame.width;
    height = frame.height;
    frames++;
    return true;
  };
  const wake = () => {
    raf = undefined;
    timer = undefined;
    // Keep the display clock running while IPC/write is in flight. Scheduling
    // only after completion adds another vsync wait to every preview frame.
    schedule();
    void pump();
  };
  const schedule = () => {
    if (closed) return;
    clearTimeout(timer);
    if (raf !== undefined) cancelAnimationFrame(raf);
    if (document.hidden) timer = setTimeout(wake, 16);
    else raf = requestAnimationFrame(wake);
  };
  const pump = async () => {
    if (closed || running) return;
    running = true;
    try {
      await draw();
    } catch (error) {
      if (!closed) {
        console.error("Native preview failed", error);
        close();
        onEnded();
      }
      return;
    } finally {
      running = false;
    }
  };
  webview.addEventListener("sharedbufferreceived", receive);
  signal?.addEventListener("abort", aborted, {
    once: true,
  });
  try {
    timeout = setTimeout(
      () =>
        rejectBuffer(
          new Error("Native preview buffer timed out"),
        ),
      10_000,
    );
    opening = invoke("capture_preview_open", {
      sessionId,
      previewId: id,
    });
    await Promise.all([opening, ready]);
    clearTimeout(timeout);
    signal?.throwIfAborted();
    const deadline = performance.now() + 10_000;
    while (!(await draw())) {
      if (closed || performance.now() > deadline)
        throw new Error(
          "Native preview did not produce a frame",
        );
      await new Promise((resolve) =>
        setTimeout(resolve, 16),
      );
    }
    if (audio) {
      audioContext = new AudioContext();
      stream.addTrack(
        audioContext
          .createMediaStreamDestination()
          .stream.getAudioTracks()[0],
      );
    }
    document.addEventListener("visibilitychange", schedule);
    // RAF is suspended in a hidden WebView. The timer also keeps PiP and
    // borrowed tracks alive; the sequence prevents copying unchanged pixels.
    schedule();
    void pump();
    return {
      stream,
      close,
      stats: () => ({
        id,
        timestamp: performance.now(),
        width,
        height,
        frames,
        implementation: presenter.implementation,
      }),
    };
  } catch (error) {
    close();
    throw error;
  }
}
