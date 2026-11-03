import { invoke } from "@tauri-apps/api/core";

interface CameraProcessor {
  new (options: {
    track: MediaStreamTrack;
    maxBufferSize: number;
  }): { readable: ReadableStream<VideoFrame> };
}
async function feedCamera(
  id: string,
  track: MediaStreamTrack,
  signal: AbortSignal,
) {
  const Processor = (
    window as Window & {
      MediaStreamTrackProcessor?: CameraProcessor;
    }
  ).MediaStreamTrackProcessor;
  if (!Processor)
    throw new Error("Camera frame access unavailable");
  const reader = new Processor({
    track,
    maxBufferSize: 1,
  }).readable.getReader();
  const stop = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", stop, { once: true });
  try {
    while (!signal.aborted) {
      const { done, value: frame } = await reader.read();
      if (done) break;
      try {
        const rect = frame.visibleRect;
        if (!rect) continue;
        const width = rect.width,
          height = rect.height;
        const format =
          frame.format === "I420" || frame.format === "NV12"
            ? frame.format
            : "BGRA";
        const options: VideoFrameCopyToOptions = {
          rect,
          // Chromium treats an explicit YUV format as a conversion request.
          ...(format === frame.format ? {} : { format }),
        };
        const bytes = new Uint8Array(
          frame.allocationSize(options),
        );
        await frame.copyTo(bytes, options);
        if (!signal.aborted)
          await invoke("room_write", bytes, {
            headers: {
              "x-weblink-handle": id,
              "x-weblink-payload": format.toLowerCase(),
              "x-width": String(width),
              "x-height": String(height),
            },
          });
      } finally {
        frame.close();
      }
    }
  } finally {
    signal.removeEventListener("abort", stop);
    reader.releaseLock();
  }
}
async function feedMicrophone(
  id: string,
  track: MediaStreamTrack,
  signal: AbortSignal,
  failed: (error: unknown) => void,
) {
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  const close = () => {
    void context.close().catch(() => {});
  };
  signal.addEventListener("abort", close, { once: true });
  const resume = () => {
    if (context.state === "suspended")
      void context.resume().catch(failed);
  };
  for (const event of ["pointerdown", "keydown"])
    document.addEventListener(event, resume, {
      capture: true,
      signal,
    });
  try {
    await context.audioWorklet.addModule(
      new URL(
        "./microphone.worklet.js?no-inline",
        import.meta.url,
      ).href,
    );
    signal.throwIfAborted();
    const node = new AudioWorkletNode(
      context,
      "weblink-room-microphone",
      { numberOfInputs: 1, numberOfOutputs: 1 },
    );
    const source = context.createMediaStreamSource(
      new MediaStream([track]),
    );
    source.connect(node);
    // The worklet writes no output samples. Connecting it keeps capture scheduled.
    node.connect(context.destination);
    node.port.onmessage = ({
      data,
    }: MessageEvent<ArrayBuffer>) => {
      if (signal.aborted) return;
      void invoke("room_write", data, {
        headers: {
          "x-weblink-handle": id,
          "x-weblink-payload": "audio",
        },
      }).then(() => {
        if (!signal.aborted) node.port.postMessage(true);
      }, failed);
    };
    signal.addEventListener(
      "abort",
      () => {
        node.port.close();
        source.disconnect();
        node.disconnect();
      },
      { once: true },
    );
    resume();
  } catch (error) {
    close();
    throw error;
  }
}

type Lease = {
  id: string;
  ready: Promise<void>;
  release(): void;
};
type Entry = {
  id: string;
  ready: Promise<void>;
  controller: AbortController;
  users: Set<(cause: unknown) => void>;
  owner: string;
};
export class RoomCaptures {
  private readonly entries = new WeakMap<
    MediaStreamTrack,
    Entry
  >();
  acquire(
    peer: string,
    track: MediaStreamTrack,
    onError: (cause: unknown) => void,
  ): Lease {
    let entry = this.entries.get(track);
    if (!entry) {
      const id = crypto.randomUUID();
      const controller = new AbortController(),
        users = new Set<(cause: unknown) => void>();
      const failed = (error: unknown) => {
        if (!controller.signal.aborted)
          for (const notify of [...users]) notify(error);
      };
      const ready = invoke<void>("room_operation", {
        id: peer,
        operation: {
          type: "open-source",
          source: id,
          kind: track.kind,
          channels: 2,
        },
      }).then(async () => {
        if (controller.signal.aborted) return;
        if (track.kind === "video")
          void feedCamera(
            id,
            track,
            controller.signal,
          ).catch(failed);
        else
          await feedMicrophone(
            id,
            track,
            controller.signal,
            failed,
          );
      });
      entry = { id, ready, controller, users, owner: peer };
      this.entries.set(track, entry);
    }
    const current = entry;
    current.users.add(onError);
    return {
      id: current.id,
      ready: current.ready,
      release: () => {
        if (
          !current.users.delete(onError) ||
          current.users.size
        )
          return;
        if (this.entries.get(track) === current)
          this.entries.delete(track);
        current.controller.abort();
        void current.ready
          .catch(() => {})
          .then(() =>
            invoke("room_operation", {
              id: current.owner,
              operation: {
                type: "close-source",
                source: current.id,
              },
            }),
          )
          .catch(() => {});
      },
    };
  }
}
