import type {
  FileStorage,
  WritableStoredFile,
} from "@/libs/domain/file-storage";
import type { StoredFile } from "@weblink/platform";
import { createRecordingAudio } from "./recording-audio";
import { WebmRecordingMetadata } from "./recording-webm";
import {
  recordingFormat,
  recordingVideoBitrate,
} from "./recording-options";

export interface RecordingInput {
  stream: MediaStream;
  close(): void;
}
export interface RecordingSource {
  id: string;
  name: string;
  local?: boolean;
  video: MediaStreamTrack;
  audio: readonly MediaStreamTrack[];
  available(): boolean;
  open?(
    signal: AbortSignal,
    ended: (error?: Error) => void,
  ): Promise<RecordingInput>;
}
export interface RecordingState {
  sourceId: string;
  name: string;
  phase: "preparing" | "recording" | "paused" | "saving";
  bytes: number;
  elapsed: number;
}
interface Session {
  source: RecordingSource;
  state: RecordingState;
  controller: AbortController;
  listeners: AbortController;
  writer?: WritableStoredFile;
  input?: RecordingInput;
  audio?: ReturnType<typeof createRecordingAudio>;
  recorder?: MediaRecorder;
  webm?: WebmRecordingMetadata;
  output?: { name: string; type: string };
  timer?: ReturnType<typeof setInterval>;
  started?: number;
  pausedAt?: number;
  pausedDuration: number;
  queue: Promise<void>;
  pending: number;
  stopping: boolean;
  finishing: boolean;
  error?: unknown;
  done: Promise<void>;
  resolve(): void;
}
const MAX_PENDING = 32 * 1024 * 1024;

/** Owns recording independently of tiles, dialogs and preview playback. */
export class RecordingService {
  private session?: Session;
  constructor(
    private readonly port: {
      storage: Pick<
        FileStorage,
        "authorizeDefault" | "createWritableFile"
      >;
      changed(state: RecordingState | null): void;
      complete(result: {
        id: string;
        file: StoredFile;
      }): Promise<void>;
      failed(error: unknown): void;
      recorder?: typeof MediaRecorder;
    },
  ) {}
  get supported(): boolean {
    return (
      typeof (
        this.port.recorder ?? globalThis.MediaRecorder
      ) === "function"
    );
  }
  get activeSource(): RecordingSource | undefined {
    return this.session?.source;
  }
  private update(session: Session) {
    if (this.session !== session) return;
    if (session.started !== undefined && !session.stopping)
      session.state.elapsed =
        (session.pausedAt ?? performance.now()) -
        session.started -
        session.pausedDuration;
    this.port.changed({ ...session.state });
  }
  sync(): void {
    const session = this.session;
    if (session && !session.source.available())
      void this.stop();
  }
  async start(source: RecordingSource): Promise<void> {
    try {
      if (this.session)
        throw new Error(
          "Another recording is already active",
        );
      if (!this.supported)
        throw new Error(
          "Recording is unavailable in this browser",
        );
      if (
        source.video.readyState !== "live" ||
        !source.available()
      )
        throw new Error(
          "The selected video source has ended",
        );
    } catch (error) {
      this.port.failed(error);
      throw error;
    }
    let resolve!: () => void;
    const session: Session = {
      source,
      state: {
        sourceId: source.id,
        name: source.name,
        phase: "preparing",
        bytes: 0,
        elapsed: 0,
      },
      controller: new AbortController(),
      listeners: new AbortController(),
      pausedDuration: 0,
      pending: 0,
      stopping: false,
      finishing: false,
      queue: Promise.resolve(),
      done: new Promise<void>((done) => {
        resolve = done;
      }),
      resolve: () => resolve(),
    };
    this.session = session;
    this.update(session);
    const fail = (error: unknown) => {
      session.error ??= error;
      void this.stop();
    };
    try {
      // Resume inside the start gesture, before permission/native-stream awaits.
      if (
        source.audio.length &&
        typeof AudioContext !== "undefined"
      )
        session.audio = createRecordingAudio(
          session.controller.signal,
        );
      // Permission request must precede preparation and native connection awaits.
      // A new recording cannot reuse old content; a full directory scan only
      // delays capture. Ordinary imports still refresh before deduplication.
      await this.port.storage.authorizeDefault({
        refresh: false,
      });
      session.controller.signal.throwIfAborted();
      session.input = source.open
        ? await source.open(
            session.controller.signal,
            (error) => {
              if (error) fail(error);
              else void this.stop();
            },
          )
        : {
            stream: new MediaStream([
              source.video,
              ...source.audio,
            ]),
            close() {},
          };
      session.controller.signal.throwIfAborted();
      if (!source.available())
        throw new Error(
          "The selected video source has ended",
        );
      if (
        session.input.stream.getAudioTracks().length &&
        !session.audio &&
        typeof AudioContext !== "undefined"
      )
        session.audio = createRecordingAudio(
          session.controller.signal,
        );
      await session.audio?.ready;
      session.controller.signal.throwIfAborted();
      const stream = session.audio
        ? await session.audio.stream(session.input.stream)
        : session.input.stream;
      session.controller.signal.throwIfAborted();
      const Constructor =
        this.port.recorder ?? MediaRecorder;
      const audio =
        session.input.stream.getAudioTracks().length > 0;
      const videoBitsPerSecond = recordingVideoBitrate(
        stream.getVideoTracks()[0]?.getSettings?.(),
      );
      let cause: unknown = new Error(
        "No supported recording format",
      );
      for (const mimeType of [
        // Raw local capture needs an encoder. An explicit container lets
        // Chromium choose from its accelerated codec profiles; an empty type
        // falls back to VP8. Matroska also permits hardware H.264 encoders.
        // Native screen inputs opened over WebRTC still need pass-through.
        ...(source.local && !source.open
          ? ["video/x-matroska"]
          : []),
        // An explicit MIME disables Chromium's encoded WebRTC pass-through.
        // Let the browser reuse received frames before requesting an encoder.
        undefined,
        audio
          ? "video/webm;codecs=vp8,opus"
          : "video/webm;codecs=vp8",
        "video/webm",
        "video/mp4",
      ]) {
        if (
          mimeType &&
          !Constructor.isTypeSupported(mimeType)
        )
          continue;
        try {
          session.recorder = new Constructor(stream, {
            ...(mimeType ? { mimeType } : {}),
            videoBitsPerSecond,
          });
          break;
        } catch (error) {
          cause = error;
        }
      }
      const recorder = session.recorder;
      if (!recorder) throw cause;
      // Automatic recording may not report its actual container until data arrives.
      // Reserve a draft now so permissions, the target mount and write failures
      // are settled before capture starts; publish under the actual format later.
      const provisional = recordingFormat(
        recorder.mimeType || "video/webm",
      );
      const stamp = new Date()
        .toISOString()
        .replace(/[:.]/g, "-");
      const basename = `${Array.from(source.name).slice(0, 32).join("")}_${stamp}`;
      session.output = {
        name: `${basename}.${provisional.extension}`,
        type: provisional.type,
      };
      session.writer =
        await this.port.storage.createWritableFile({
          ...session.output,
          signal: session.controller.signal,
        });
      session.controller.signal.throwIfAborted();
      let formatKnown = false;
      recorder.addEventListener(
        "dataavailable",
        (event) => {
          const blob = event.data;
          if (!blob.size || session.error) return;
          if (!formatKnown) {
            try {
              const format = recordingFormat(
                blob.type || recorder.mimeType,
              );
              session.output = {
                name: `${basename}.${format.extension}`,
                type: format.type,
              };
              if (format.extension !== "mp4")
                session.webm = new WebmRecordingMetadata();
              formatKnown = true;
            } catch (error) {
              fail(error);
              return;
            }
          }
          if (session.pending + blob.size > MAX_PENDING) {
            fail(
              new Error(
                "Recording storage cannot keep up; recording stopped before exhausting memory",
              ),
            );
            return;
          }
          session.pending += blob.size;
          const next = session.queue
            .then(async () => {
              for (
                let offset = 0;
                offset < blob.size;
                offset += 1024 * 1024
              ) {
                const bytes = await blob
                  .slice(offset, offset + 1024 * 1024)
                  .arrayBuffer();
                const output =
                  session.webm?.write(
                    new Uint8Array(bytes),
                  ) ?? new Uint8Array(bytes);
                if (output.length)
                  await session.writer!.write(output);
                session.state.bytes += output.length;
              }
              this.update(session);
            })
            .finally(() => {
              session.pending -= blob.size;
            });
          session.queue = next;
          void next.catch(fail);
        },
        { signal: session.listeners.signal },
      );
      recorder.addEventListener(
        "error",
        (event) =>
          fail(
            (event as Event & { error?: DOMException })
              .error ?? new Error("Media recording failed"),
          ),
        { signal: session.listeners.signal },
      );
      recorder.addEventListener(
        "stop",
        () => {
          void this.finish(session);
        },
        { signal: session.listeners.signal },
      );
      for (const track of new Set([
        source.video,
        ...source.audio,
        ...session.input.stream.getTracks(),
      ]))
        track.addEventListener(
          "ended",
          () => {
            void this.stop();
          },
          { signal: session.listeners.signal },
        );
      if (!source.available())
        throw new Error(
          "The selected video source has ended",
        );
      // This only flushes encoded bytes; never restart the encoder for each chunk.
      recorder.start(1000);
      session.started = performance.now();
      session.state.phase = "recording";
      session.timer = setInterval(
        () => this.update(session),
        500,
      );
      this.update(session);
    } catch (error) {
      if (!session.stopping || session.error)
        session.error ??= error;
      await this.finish(session, false);
      if (session.error) throw session.error;
    }
  }
  pause(): void {
    const session = this.session;
    if (
      !session ||
      session.stopping ||
      session.state.phase !== "recording"
    )
      return;
    try {
      session.recorder!.pause();
      session.pausedAt = performance.now();
      session.state.phase = "paused";
      this.update(session);
    } catch (error) {
      session.error ??= error;
      void this.stop();
    }
  }
  resume(): void {
    const session = this.session;
    if (
      !session ||
      session.stopping ||
      session.state.phase !== "paused"
    )
      return;
    if (!session.source.available()) {
      void this.stop();
      return;
    }
    try {
      session.recorder!.resume();
      session.pausedDuration +=
        performance.now() - session.pausedAt!;
      session.pausedAt = undefined;
      session.state.phase = "recording";
      this.update(session);
    } catch (error) {
      session.error ??= error;
      void this.stop();
    }
  }
  stop(): Promise<void> {
    const session = this.session;
    if (!session) return Promise.resolve();
    if (session.stopping) return session.done;
    this.update(session);
    session.stopping = true;
    session.state.phase = "saving";
    clearInterval(session.timer);
    this.update(session);
    if (session.started === undefined)
      session.controller.abort();
    else if (session.recorder?.state !== "inactive") {
      try {
        session.recorder!.stop();
      } catch (error) {
        session.error ??= error;
        void this.finish(session, false);
      }
    }
    return session.done;
  }
  private async finish(
    session: Session,
    publish = true,
  ): Promise<void> {
    if (session.finishing) return session.done;
    session.finishing = true;
    this.update(session);
    session.stopping = true;
    session.state.phase = "saving";
    clearInterval(session.timer);
    this.update(session);
    try {
      await session.queue;
      if (publish && !session.error && session.writer) {
        const metadata = session.webm?.finish(
          session.state.elapsed,
        );
        if (metadata?.tail.length) {
          await session.writer.write(metadata.tail);
          session.state.bytes += metadata.tail.length;
        }
        await this.port.complete(
          await session.writer.finish(
            metadata?.patches,
            session.output,
          ),
        );
      } else await session.writer?.abort();
    } catch (error) {
      session.error ??= error;
      await session.writer?.abort().catch(() => {});
    } finally {
      session.listeners.abort();
      for (const resource of [
        session.audio,
        session.input,
      ]) {
        try {
          resource?.close();
        } catch (error) {
          session.error ??= error;
        }
      }
      try {
        if (this.session === session) {
          this.session = undefined;
          this.port.changed(null);
        }
        if (session.error) this.port.failed(session.error);
      } finally {
        session.resolve();
      }
    }
  }
}
