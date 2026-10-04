import { Channel, invoke } from "@tauri-apps/api/core";
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
type PreviewEvent =
  | { type: "visibility"; visible: boolean }
  | { type: "frame" }
  | { type: "ended" };

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
  let initialized = false;
  let nativeVisible = false;
  let dirty = true;
  let frameDue = false;
  let raf: number | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer:
    | ReturnType<typeof setTimeout>
    | undefined;
  let firstFrameReady!: () => void;
  let firstFrameFailed!: (reason: unknown) => void;
  const firstFrame = new Promise<void>(
    (resolve, reject) => {
      firstFrameReady = resolve;
      firstFrameFailed = reject;
    },
  );
  void firstFrame.catch(() => {});
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
    firstFrameFailed(new Error("Preview closed"));
    rejectBuffer(new Error("Preview closed"));
    clearTimeout(timeout);
    clearTimeout(refreshTimer);
    if (raf !== undefined) cancelAnimationFrame(raf);
    signal?.removeEventListener("abort", aborted);
    document.removeEventListener(
      "visibilitychange",
      visibilityChanged,
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
  const visible = () => nativeVisible && !document.hidden;
  const draw = async () => {
    if (closed || !visible()) return false;
    dirty = false;
    const frame = await invoke<Frame | null>(
      "capture_preview_frame",
      { previewId: id, after: sequence },
    );
    if (closed || !buffer || !visible()) return false;
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
    firstFrameReady();
    return true;
  };
  const schedule = () => {
    if (
      raf === undefined &&
      !closed &&
      initialized &&
      visible() &&
      dirty
    )
      raf = requestAnimationFrame(() => {
        raf = undefined;
        frameDue = true;
        void pump();
      });
  };
  const pump = async () => {
    if (closed || !initialized || !visible() || running)
      return;
    running = true;
    frameDue = false;
    clearTimeout(refreshTimer);
    try {
      if (dirty) await draw();
      else if (await presenter.refresh()) frames++;
    } catch (error) {
      if (!closed) {
        console.error("Native preview failed", error);
        firstFrameFailed(error);
        close();
        onEnded();
      }
      return;
    } finally {
      running = false;
      if (!closed && visible()) {
        // A display tick can arrive during IPC or a track write. Consume that
        // tick once the shared buffer is released instead of adding a second
        // vsync wait to every busy frame.
        if (dirty && frameDue)
          queueMicrotask(() => void pump());
        else schedule();
        // Static generated tracks need sparse local repeats, never another IPC read.
        if (presenter.needsRefresh)
          refreshTimer = setTimeout(() => void pump(), 500);
      }
    }
  };
  const updatePresentation = () => {
    if (!visible()) {
      if (raf !== undefined) cancelAnimationFrame(raf);
      raf = undefined;
      frameDue = false;
      clearTimeout(refreshTimer);
      firstFrameReady();
    } else {
      dirty = true;
      void pump();
    }
  };
  const visibilityChanged = () => {
    updatePresentation();
    if (initialized && !closed)
      void invoke("capture_preview_visible", {
        previewId: id,
        visible: !document.hidden,
      }).catch((error) => {
        if (!closed)
          console.warn(
            "Could not update preview visibility",
            error,
          );
      });
  };
  // Native visibility covers explicit tray/control hiding and minimization even
  // when WebView2 keeps its document active. An unfocused, visible PiP still runs.
  const events = new Channel<PreviewEvent>((event) => {
    if (closed) return;
    if (event.type === "ended") {
      close();
      onEnded();
    } else if (event.type === "frame") {
      dirty = true;
      schedule();
    } else if (nativeVisible !== event.visible) {
      nativeVisible = event.visible;
      updatePresentation();
    }
  });
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
      events,
      visible: !document.hidden,
    });
    await Promise.all([opening, ready]);
    clearTimeout(timeout);
    signal?.throwIfAborted();
    initialized = true;
    document.addEventListener(
      "visibilitychange",
      visibilityChanged,
    );
    visibilityChanged();
    if (visible()) {
      timeout = setTimeout(
        () =>
          firstFrameFailed(
            new Error(
              "Native preview did not produce a frame",
            ),
          ),
        10_000,
      );
      await firstFrame;
      clearTimeout(timeout);
    }
    signal?.throwIfAborted();
    if (closed) throw new Error("Preview closed");
    if (audio) {
      audioContext = new AudioContext();
      stream.addTrack(
        audioContext
          .createMediaStreamDestination()
          .stream.getAudioTracks()[0],
      );
    }
    // Pause only presentation: retain the stream, mapping and capture ownership
    // while hidden, then request the latest frame when the window returns.
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
