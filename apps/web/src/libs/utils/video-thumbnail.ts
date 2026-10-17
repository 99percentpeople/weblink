import type { StoredFile } from "@weblink/platform";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "./stored-file";

const thumbnails = new WeakMap<StoredFile, Blob>();
let queue = Promise.resolve();

/** Decode one file at a time, then retain only a small poster for that snapshot. */
export function videoThumbnail(
  file: StoredFile,
  signal: AbortSignal,
): Promise<Blob> {
  const next = queue.then(async () => {
    signal.throwIfAborted();
    const cached = thumbnails.get(file);
    if (cached) return cached;
    const url = await fileObjectUrl(file, signal);
    try {
      signal.throwIfAborted();
      const poster = await captureFrame(url, signal);
      signal.throwIfAborted();
      thumbnails.set(file, poster);
      return poster;
    } finally {
      revokeFileUrl(url);
    }
  });
  queue = next.then(
    () => {},
    () => {},
  );
  return next;
}

function captureFrame(
  url: string,
  signal: AbortSignal,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const listeners = new AbortController();
    let finished = false;
    let capturing = false;
    const finish = (poster?: Blob, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      listeners.abort();
      signal.removeEventListener("abort", aborted);
      video.removeAttribute("src");
      video.load();
      if (poster) resolve(poster);
      else
        reject(
          error ??
            new Error("Video preview is unavailable"),
        );
    };
    const aborted = () => finish(undefined, signal.reason);
    const capture = () => {
      if (
        finished ||
        capturing ||
        video.seeking ||
        video.readyState < 2
      )
        return;
      if (!video.videoWidth || !video.videoHeight) {
        finish();
        return;
      }
      capturing = true;
      const canvas = document.createElement("canvas");
      const scale = Math.min(
        1,
        160 / Math.max(video.videoWidth, video.videoHeight),
      );
      canvas.width = Math.max(
        1,
        Math.round(video.videoWidth * scale),
      );
      canvas.height = Math.max(
        1,
        Math.round(video.videoHeight * scale),
      );
      try {
        const context = canvas.getContext("2d");
        if (!context) return finish();
        context.drawImage(
          video,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        canvas.toBlob(
          (poster) => finish(poster ?? undefined),
          "image/jpeg",
          0.8,
        );
      } catch (error) {
        finish(undefined, error);
      }
    };
    const timeout = setTimeout(() => finish(), 12000);
    signal.addEventListener("abort", aborted, {
      once: true,
    });
    video.addEventListener("error", () => finish(), {
      signal: listeners.signal,
    });
    video.addEventListener(
      "loadedmetadata",
      () => {
        // Avoid a title/black opening frame when seeking is available.
        const time = Number.isFinite(video.duration)
          ? Math.min(1, video.duration / 2)
          : 0;
        try {
          if (time > 0) video.currentTime = time;
          else capture();
        } catch {
          capture();
        }
      },
      { signal: listeners.signal },
    );
    video.addEventListener("loadeddata", capture, {
      signal: listeners.signal,
    });
    video.addEventListener("seeked", capture, {
      signal: listeners.signal,
    });
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.src = url;
    if (signal.aborted) aborted();
  });
}
