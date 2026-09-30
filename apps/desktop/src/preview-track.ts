interface GeneratedVideoTrack extends MediaStreamTrack {
  writable: WritableStream<VideoFrame>;
}
interface PreviewTrack {
  stream: MediaStream;
  implementation: string;
  /** The owner serializes writes and closes each input frame. */
  write(frame: VideoFrame): Promise<void>;
  refresh(): Promise<boolean>;
  close(): void;
}

/** Keep raw I420 frames in the video pipeline instead of drawing and then
 * recapturing a Canvas. The Canvas path supports older WebView2 runtimes. */
export function createPreviewTrack(): PreviewTrack {
  const Generator = (
    globalThis as typeof globalThis & {
      MediaStreamTrackGenerator?: new (options: {
        kind: "video";
      }) => GeneratedVideoTrack;
    }
  ).MediaStreamTrackGenerator;
  if (Generator) {
    let track: GeneratedVideoTrack | undefined;
    try {
      track = new Generator({ kind: "video" });
      return generatedTrack(track);
    } catch {
      track?.stop();
    }
  }
  return canvasTrack();
}

function generatedTrack(
  track: GeneratedVideoTrack,
): PreviewTrack {
  const stream = new MediaStream([track]);
  const writer = track.writable.getWriter();
  // The stream owner may wrap track.stop() to stop native capture as well.
  const stop = track.stop.bind(track);
  let closed = false;
  let latest: VideoFrame | undefined;
  let lastWrite = 0;
  const write = async (frame: VideoFrame) => {
    if (closed)
      throw new DOMException(
        "Preview closed",
        "AbortError",
      );
    const retained = frame.clone();
    latest?.close();
    latest = retained;
    lastWrite = performance.now();
    // Awaiting each write keeps at most one submission in flight. Chromium
    // consumes/closes the input, while our one retained clone shares its pixels.
    await writer.write(frame);
  };
  return {
    stream,
    implementation: "Shared memory / VideoFrame",
    write,
    refresh: async () => {
      if (
        closed ||
        !latest ||
        performance.now() - lastWrite < 500
      )
        return false;
      // Generated tracks do not cache a frame for a newly attached player.
      // Sparse repeats keep static previews usable after mount/visibility/PiP
      // changes without recopying shared memory or queuing historical frames.
      const frame = new VideoFrame(latest, {
        timestamp: Math.round(performance.now() * 1000),
      });
      try {
        await write(frame);
        return true;
      } finally {
        frame.close();
      }
    },
    close: () => {
      if (closed) return;
      closed = true;
      latest?.close();
      latest = undefined;
      stop();
      void writer
        .abort()
        .catch(() => {})
        .finally(() => writer.releaseLock());
    },
  };
}

function canvasTrack(): PreviewTrack {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 2;
  const context = canvas.getContext("2d", { alpha: false });
  if (!context)
    throw new Error(
      "Could not create screen preview canvas",
    );
  const stream = canvas.captureStream(0);
  const video =
    stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack;
  const stop = video.stop.bind(video);
  let closed = false;
  return {
    stream,
    implementation: "Shared memory / Canvas",
    write: async (frame) => {
      if (closed)
        throw new DOMException(
          "Preview closed",
          "AbortError",
        );
      if (
        canvas.width !== frame.displayWidth ||
        canvas.height !== frame.displayHeight
      ) {
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;
      }
      context.drawImage(frame, 0, 0);
      video.requestFrame();
    },
    refresh: async () => false,
    close: () => {
      if (closed) return;
      closed = true;
      stop();
      canvas.width = canvas.height = 2;
    },
  };
}
