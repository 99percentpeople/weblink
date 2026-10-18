import {
  ALL_FORMATS,
  Conversion,
  Input,
  Output,
  ReadableStreamSource,
  StreamTarget,
} from "mediabunny";
import type { RecordingEngine } from "./recording-engine";
import { RecordingMuxerWrites } from "./recording-muxer-writes";
import { recordingContainer } from "./recording-container";
import {
  recordingContainerForCodec,
  type RecordingContainer,
} from "./recording-options";

const MAX_PENDING = 32 * 1024 * 1024;

/** Repackages MediaRecorder's live output without decoding or encoding tracks. */
class RemuxedRecording
  extends EventTarget
  implements RecordingEngine
{
  mimeType: string;
  private listeners = new AbortController();
  private writes = new RecordingMuxerWrites();
  private input?: Input;
  private output?: Output;
  private conversion?: Conversion;
  private writer?: WritableStreamDefaultWriter<Uint8Array>;
  private queue = Promise.resolve();
  private converting?: Promise<void>;
  private finishing?: Promise<void>;
  private pending = 0;
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setInterval>;
  private failed = false;
  private disposed = false;
  private stopping = false;

  constructor(
    private readonly recorder: RecordingEngine,
    private readonly container: RecordingContainer,
  ) {
    super();
    // The first demuxed video track chooses automatic output. VFS publishes the
    // actual name/type after the first output chunk, on the original mount.
    this.mimeType = recordingContainer(
      container === "auto" ? "mkv" : container,
    ).mimeType;
    const options = { signal: this.listeners.signal };
    recorder.addEventListener(
      "dataavailable",
      (event) => this.accept((event as BlobEvent).data),
      options,
    );
    recorder.addEventListener(
      "error",
      (event) =>
        this.fail(
          (event as Event & { error?: unknown }).error ??
            new Error("Media recording failed"),
        ),
      options,
    );
    recorder.addEventListener(
      "stop",
      () => void this.finish(),
      options,
    );
  }

  get state(): RecordingState {
    return this.recorder.state;
  }
  start(timeslice = 1000): void {
    const stream = new TransformStream<Uint8Array>();
    this.writer = stream.writable.getWriter();
    this.input = new Input({
      formats: ALL_FORMATS,
      source: new ReadableStreamSource(stream.readable, {
        maxCacheSize: 16 * 1024 * 1024,
        handleUnhandledError: (error) => this.fail(error),
      }),
    });
    this.converting = this.convert();
    void this.converting.catch((error) => this.fail(error));
    this.timer = setInterval(() => this.flush(), timeslice);
    this.recorder.start(timeslice);
  }

  private async convert(): Promise<void> {
    const video = await this.input!.getPrimaryVideoTrack();
    if (this.disposed || this.failed) return;
    if (!video?.codec)
      throw new Error(
        "Recording has no supported video track",
      );
    const format = recordingContainer(
      recordingContainerForCodec(
        this.container,
        video.codec,
      ),
    );
    const configs = await Promise.all(
      (await this.input!.getTracks()).map((track) =>
        track.getCodecParameterString(),
      ),
    );
    if (this.disposed || this.failed) return;
    this.mimeType = `${format.mimeType};codecs=${configs.join(",")}`;
    this.output = new Output({
      format,
      target: new StreamTarget(
        new WritableStream({
          write: (chunk) => {
            const bytes = this.writes.write(chunk);
            if (
              !bytes.length ||
              this.disposed ||
              this.failed
            )
              return;
            this.chunks.push(bytes);
            this.bytes += bytes.length;
            if (this.bytes >= 1024 * 1024) this.flush();
          },
        }),
      ),
    });
    this.conversion = await Conversion.init({
      input: this.input!,
      output: this.output!,
      // Never silently introduce a video encoder or drop an audio track.
      copy: { mode: "forced" },
    });
    if (
      !this.conversion.isValid ||
      this.conversion.discardedTracks.length
    )
      throw new Error(
        `Recording tracks cannot be saved as ${format.fileExtension} without re-encoding`,
      );
    if (this.disposed || this.failed) return;
    await this.conversion.execute();
  }

  private flush(): void {
    if (!this.bytes || this.disposed || this.failed) return;
    const data = new Blob(this.chunks, {
      type: this.mimeType,
    });
    this.chunks = [];
    this.bytes = 0;
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data }),
    );
  }

  private accept(blob: Blob): void {
    if (!blob.size || this.disposed || this.failed) return;
    if (this.pending + blob.size > MAX_PENDING) {
      this.fail(
        new Error(
          "Recording container cannot keep up; recording stopped before exhausting memory",
        ),
      );
      return;
    }
    this.pending += blob.size;
    this.queue = this.queue
      .then(async () => {
        for (
          let offset = 0;
          offset < blob.size;
          offset += 1024 * 1024
        ) {
          if (this.disposed || this.failed) return;
          const bytes = await blob
            .slice(offset, offset + 1024 * 1024)
            .arrayBuffer();
          await this.writer!.write(new Uint8Array(bytes));
        }
      })
      .finally(() => {
        this.pending -= blob.size;
      });
    void this.queue.catch((error) => this.fail(error));
  }

  pause(): void {
    this.recorder.pause();
  }
  resume(): void {
    this.recorder.resume();
  }
  stop(): void {
    if (this.stopping || this.disposed) return;
    this.stopping = true;
    if (this.recorder.state !== "inactive")
      this.recorder.stop();
    else void this.finish();
  }
  private finish(): Promise<void> {
    return (this.finishing ??= (async () => {
      try {
        await this.queue;
        if (!this.failed && !this.disposed)
          await this.writer?.close();
        await this.converting;
        this.flush();
      } catch (error) {
        this.fail(error);
      } finally {
        clearInterval(this.timer);
        if (!this.disposed)
          this.dispatchEvent(new Event("stop"));
      }
    })());
  }
  private fail(error: unknown): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    // Reject pending reads/writes before waiting for the recorder's final event.
    this.input?.dispose();
    void this.writer?.abort(error).catch(() => {});
    this.dispatchEvent(
      Object.assign(new Event("error"), { error }),
    );
    this.stop();
  }
  getPatches() {
    return this.writes.patches;
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    this.listeners.abort();
    if (this.recorder.state !== "inactive")
      this.recorder.stop();
    this.input?.dispose();
    await this.writer?.abort().catch(() => {});
    await this.converting?.catch(() => {});
    if (this.output?.state !== "finalized")
      await this.output?.cancel();
    await this.recorder.dispose?.();
    this.chunks = [];
    this.bytes = 0;
  }
}

export function remuxRecording(
  recorder: RecordingEngine,
  container: RecordingContainer,
): RecordingEngine {
  return new RemuxedRecording(recorder, container);
}
