import {
  AudioSample,
  AudioSampleSource,
  canEncodeAudio,
  EncodedPacket,
  EncodedVideoPacketSource,
  MediaStreamAudioTrackSource,
  Output,
  NullTarget,
  StreamTarget,
} from "mediabunny";
import type {
  EncodedVideoPacket,
  EncodedVideoSource,
  EncodedVideoSubscription,
  RecordingAudioPacket,
  EncodedAudioPacket,
} from "@/libs/domain/encoded-video";
import type { RecordingEngine } from "./recording-engine";
import type { VfsWrite } from "@weblink/platform";
import { RecordingMuxerWrites } from "./recording-muxer-writes";
import { recordingContainer } from "./recording-container";
import {
  recordingContainerForCodec,
  type RecordingContainer,
} from "./recording-options";
import {
  recordingNalUnits,
  recordingVideoConfig,
} from "./recording-video-config";
import {
  encodedRecordingFormat,
  RecordingRtpTimeline,
} from "./recording-encoded-format";
import { RecordingEncodedAudio } from "./recording-encoded-audio";

/** Muxes borrowed video and, when available, the original audio codec. Other audio uses the selected-source mix. */
class EncodedRecording
  extends EventTarget
  implements RecordingEngine
{
  state: RecordingState = "inactive";
  mimeType = "";
  private subscription?: EncodedVideoSubscription;
  private format?: Awaited<
    ReturnType<typeof encodedRecordingFormat>
  >;
  private output?: Output;
  private container?: ReturnType<typeof recordingContainer>;
  private video?: EncodedVideoPacketSource;
  private audio?: MediaStreamAudioTrackSource;
  private encodedAudio?: RecordingEncodedAudio;
  private firstAudio?: {
    resolve(packet: EncodedAudioPacket): void;
    reject(error: unknown): void;
  };
  private audioEnd = 0;
  private pcm?: AudioSampleSource;
  private pcmEnd = 0;
  private minimumSegment = 0;
  private segment = -1;
  private timeline = new RecordingRtpTimeline();
  private chunks: Uint8Array<ArrayBuffer>[] = [];
  private bytes = 0;
  private writes = new RecordingMuxerWrites();
  private incompatible = false;
  private timer?: ReturnType<typeof setInterval>;
  private keyTimer?: ReturnType<typeof setTimeout>;
  private finishing?: Promise<void>;
  private disposed = false;
  private started = false;
  private failure?: unknown;
  private sourceEnded = false;
  private initial: (() => Promise<void>)[] = [];
  private initialBytes = 0;
  private queue = Promise.resolve();
  private first?: {
    resolve(packet: EncodedVideoPacket): void;
    reject(error: unknown): void;
  };

  async prepare(
    source: EncodedVideoSource,
    audio: MediaStreamAudioTrack | undefined,
    signal: AbortSignal,
    container: RecordingContainer,
  ) {
    const first = new Promise<EncodedVideoPacket>(
      (resolve, reject) => {
        this.first = { resolve, reject };
      },
    );
    void first.catch(() => {});
    const firstAudio = new Promise<EncodedAudioPacket>(
      (resolve, reject) => {
        this.firstAudio = { resolve, reject };
      },
    );
    void firstAudio.catch(() => {});
    const abort = () => {
      this.first?.reject(signal.reason);
      this.firstAudio?.reject(signal.reason);
    };
    const timer = setTimeout(() => {
      const error = new Error(
        "No reusable synchronized audio/video frames",
      );
      this.first?.reject(error);
      this.firstAudio?.reject(error);
    }, 2500);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      this.subscription =
        (await source.subscribe(
          {
            frame: (packet) => this.frame(packet),
            audio: (packet) => this.audioFrame(packet),
            encodedAudio: (packet) =>
              this.encodedAudioFrame(packet),
            ended: (error) => {
              this.sourceEnded = true;
              if (error) this.fail(error);
              else if (this.first)
                this.fail(
                  new Error("Recording source ended"),
                );
              else if (this.started) this.stop();
            },
          },
          signal,
        )) ?? undefined;
      if (!this.subscription)
        throw new Error(
          "Sender is not available for recording",
        );
      this.subscription.resume();
      const packet = await first;
      if (this.subscription.encodedAudio) {
        const sound = await firstAudio;
        if (!Number.isFinite(packet.clockTime))
          throw new Error(
            "Video capture clock is unavailable",
          );
        this.encodedAudio = new RecordingEncodedAudio(
          sound,
          this.writes,
        );
      }
      this.minimumSegment = packet.segment - 1;
      this.format = await encodedRecordingFormat(packet);
      const selected = recordingContainerForCodec(
        container,
        this.format.codec,
        this.encodedAudio?.codec,
      );
      this.container = recordingContainer(selected);
      if (
        this.encodedAudio &&
        !this.container
          .getSupportedAudioCodecs()
          .includes(this.encodedAudio.codec)
      )
        throw new Error(
          "Selected recording container cannot preserve this audio codec",
        );
      if (
        selected === "mkv" &&
        (this.format.codec === "avc" ||
          this.format.codec === "hevc")
      ) {
        this.format.config = await recordingVideoConfig(
          this.format.codec,
          this.format.config,
          packet.data,
        );
        this.format.bytes = (next) =>
          recordingNalUnits(next.data);
      }
      await this.probeVideo(packet);
      const pcmFormat = this.subscription.audioFormat;
      // Capture can exceed Opus input rates. Resample PCM while preserving its clock.
      const pcmSampleRate = 48000;
      if (
        pcmFormat &&
        !(await canEncodeAudio("opus", {
          sampleRate: pcmSampleRate,
          numberOfChannels: pcmFormat.channelCount,
          bitrate: 128000,
        }))
      )
        throw new Error(
          "Native recording audio encoder is unavailable",
        );
      this.mimeType = `${this.container.mimeType};codecs=${this.format.config.codec}${this.encodedAudio ? `,${this.encodedAudio.codec}` : audio || pcmFormat ? ",opus" : ""}`;
      this.output = new Output({
        format: this.container,
        target: new StreamTarget(
          new WritableStream({
            write: (chunk) => {
              const data = this.writes.write(chunk);
              if (!data.length) return;
              this.chunks.push(data);
              this.bytes += data.length;
              if (this.started && this.bytes >= 1024 * 1024)
                this.flush();
            },
          }),
        ),
      });
      this.video = new EncodedVideoPacketSource(
        this.format.codec,
      );
      this.output.addVideoTrack(this.video);
      if (this.encodedAudio) {
        this.output.addAudioTrack(this.encodedAudio.source);
      } else if (pcmFormat) {
        this.pcm = new AudioSampleSource({
          codec: "opus",
          bitrate: 128000,
          transform:
            pcmFormat.sampleRate === pcmSampleRate
              ? undefined
              : { sampleRate: pcmSampleRate },
          onEncodedPacket: (packet) => {
            try {
              this.writes.accountPacket(packet.data.length);
            } catch (error) {
              this.fail(error);
            }
            this.audioEnd =
              packet.timestamp + packet.duration;
          },
        });
        this.output.addAudioTrack(this.pcm);
      } else if (audio) {
        this.audio = new MediaStreamAudioTrackSource(
          audio,
          {
            codec: "opus",
            bitrate: 128000,
            onEncodedPacket: (packet) => {
              try {
                this.writes.accountPacket(
                  packet.data.length,
                );
              } catch (error) {
                this.fail(error);
              }
              this.audioEnd =
                packet.timestamp + packet.duration;
            },
          },
          { timestampBase: "zero" },
        );
        this.audio.pause();
        void this.audio.errorPromise.catch((error) =>
          this.fail(error),
        );
        this.output.addAudioTrack(this.audio);
      }
      await this.output.start();
      if (this.failure) throw this.failure;
      if (this.sourceEnded) throw new Error("Sender ended");
      signal.throwIfAborted();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      this.first = undefined;
      this.firstAudio = undefined;
      // A synchronous refusal/abort must not leave a rejected probe unobserved.
      void first.catch(() => {});
    }
  }

  private async probeVideo(packet: EncodedVideoPacket) {
    const output = new Output({
      format: this.container!,
      target: new NullTarget(),
    });
    const video = new EncodedVideoPacketSource(
      this.format!.codec,
    );
    output.addVideoTrack(video);
    try {
      await output.start();
      await video.add(
        new EncodedPacket(
          this.format!.bytes(packet),
          "key",
          0,
          1,
        ),
        { decoderConfig: this.format!.config },
      );
      await output.finalize();
    } finally {
      if (output.state !== "finalized")
        await output.cancel();
    }
  }

  private accept(
    bytes: number,
    write: () => Promise<void>,
  ): Promise<void> | undefined {
    if (this.disposed) return;
    if (!this.started) {
      if (
        this.initial.length >= 512 ||
        this.initialBytes + bytes > 8 * 1024 * 1024
      )
        throw new Error(
          "Recording preparation cannot keep up with the source",
        );
      this.initialBytes += bytes;
      this.initial.push(write);
      return;
    }
    this.queue = this.queue.then(write);
    void this.queue.catch((error) => this.fail(error));
    return this.queue;
  }
  private frame(packet: EncodedVideoPacket) {
    const result = this.accept(packet.data.byteLength, () =>
      this.writeVideo(packet),
    );
    this.first?.resolve(packet);
    return result;
  }
  private async writeVideo(packet: EncodedVideoPacket) {
    if (
      !this.started ||
      this.disposed ||
      this.incompatible ||
      packet.segment <= this.minimumSegment
    )
      return;
    if (!this.format!.compatible(packet)) {
      this.incompatible = true;
      this.stop();
      return;
    }
    clearTimeout(this.keyTimer);
    const timestamp = this.timeline.next(
      packet,
      Math.max(
        this.audioEnd,
        this.pcmEnd,
        this.encodedAudio?.end ?? 0,
      ),
    );
    if (this.segment !== packet.segment) {
      this.segment = packet.segment;
      this.encodedAudio?.startSegment(packet, timestamp);
      if (this.state === "recording") this.audio?.resume();
    }
    const data = this.format!.bytes(packet);
    this.writes.accountPacket(data.length);
    await this.video!.add(
      new EncodedPacket(data, packet.type, timestamp, 0),
      { decoderConfig: this.format!.config },
    );
  }

  private encodedAudioFrame(packet: EncodedAudioPacket) {
    // Receiving starts before the decoder exposes its first synchronized delivery
    // anchor. Allow the bounded preparation timeout to wait for that clock; never
    // substitute arrival time or silently discard clock failures during recording.
    if (
      this.firstAudio &&
      !Number.isFinite(packet.clockTime)
    )
      return Promise.resolve();
    const result = this.accept(
      packet.data.byteLength,
      async () => {
        if (
          this.disposed ||
          this.incompatible ||
          packet.segment <= this.minimumSegment
        )
          return;
        await this.encodedAudio?.add(packet);
      },
    );
    this.firstAudio?.resolve(packet);
    return result;
  }

  private audioFrame(packet: RecordingAudioPacket) {
    return this.accept(packet.data.byteLength, () =>
      this.writePcm(packet),
    );
  }
  private async writePcm(packet: RecordingAudioPacket) {
    if (
      !this.started ||
      this.disposed ||
      this.incompatible ||
      !this.pcm ||
      packet.segment <= this.minimumSegment
    )
      return;
    const format = this.subscription?.audioFormat;
    if (
      !format ||
      packet.sampleRate !== format.sampleRate ||
      packet.channelCount !== format.channelCount
    )
      throw new Error(
        "Native recording audio format changed",
      );
    const timestamp = this.timeline.audio(
      packet.timestamp,
      packet.segment,
    );
    if (timestamp === undefined) return;
    const stride = packet.channelCount * 2;
    if (
      !packet.data.byteLength ||
      packet.data.byteLength % stride
    )
      throw new Error(
        "Invalid native recording audio samples",
      );
    const frames = packet.data.byteLength / stride;
    // Trim samples captured before the segment's keyframe or already accepted PCM.
    const skip = Math.max(
      0,
      Math.ceil(
        (Math.max(0, this.pcmEnd) - timestamp) *
          packet.sampleRate -
          0.0001,
      ),
    );
    if (skip >= frames) return;
    const start = timestamp + skip / packet.sampleRate;
    const sample = new AudioSample({
      data: new Uint8Array(packet.data, skip * stride),
      format: "s16",
      sampleRate: packet.sampleRate,
      numberOfChannels: packet.channelCount,
      timestamp: Math.max(0, start),
    });
    try {
      await this.pcm.add(sample);
      this.pcmEnd = timestamp + frames / packet.sampleRate;
    } finally {
      sample.close();
    }
  }

  private requestSegment() {
    clearTimeout(this.keyTimer);
    this.keyTimer = setTimeout(
      () =>
        this.fail(
          new Error(
            "Recording could not obtain a sender keyframe",
          ),
        ),
      5000,
    );
    this.subscription!.resume();
  }
  start(timeslice = 1000) {
    if (this.failure) throw this.failure;
    if (this.sourceEnded) throw new Error("Sender ended");
    if (this.started || this.disposed)
      throw new Error(
        "Recording is already started or disposed",
      );
    this.started = true;
    this.state = "recording";
    this.timer = setInterval(() => this.flush(), timeslice);
    // Keep the validated keyframe and its following packets. Requesting a second
    // keyframe here hits receiver PLI rate limiting and loses the start of a clip.
    const initial = this.initial;
    this.initial = [];
    this.initialBytes = 0;
    for (const write of initial) this.accept(0, write);
  }
  pause() {
    if (this.state !== "recording") return;
    this.state = "paused";
    clearTimeout(this.keyTimer);
    this.subscription!.pause();
    this.audio?.pause();
  }
  resume() {
    if (this.state !== "paused") return;
    this.state = "recording";
    // Resume audio when the new video keyframe arrives, excluding the wait.
    this.requestSegment();
  }
  stop() {
    if (this.finishing) return;
    this.state = "inactive";
    clearInterval(this.timer);
    clearTimeout(this.keyTimer);
    this.audio?.pause();
    this.finishing = (async () => {
      try {
        await this.subscription?.stop();
        await this.queue;
        await this.encodedAudio?.finish();
        if (this.segment === -1)
          throw new Error(
            "Recording ended before the first video frame",
          );
        await this.output?.finalize();
        this.flush();
      } catch (error) {
        this.dispatchEvent(
          Object.assign(new Event("error"), { error }),
        );
      } finally {
        this.dispatchEvent(new Event("stop"));
      }
    })();
  }
  private flush() {
    if (!this.bytes || !this.started) return;
    const data = new Blob(this.chunks, {
      type: this.mimeType,
    });
    this.chunks = [];
    this.initial = [];
    this.initialBytes = 0;
    this.bytes = 0;
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data }),
    );
  }
  getPatches(): readonly VfsWrite[] {
    return this.writes.patches;
  }
  private fail(error: unknown) {
    if (this.disposed || this.finishing) return;
    this.failure ??= error;
    if (this.first) {
      this.first.reject(error);
      this.firstAudio?.reject(error);
      return;
    }
    this.dispatchEvent(
      Object.assign(new Event("error"), { error }),
    );
    if (this.started) this.stop();
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    clearTimeout(this.keyTimer);
    await this.subscription?.stop();
    await this.finishing;
    if (this.output?.state !== "finalized")
      await this.output?.cancel();
    this.chunks = [];
  }
}

export async function createEncodedRecording(
  sources: readonly EncodedVideoSource[],
  stream: MediaStream,
  signal: AbortSignal,
  container: RecordingContainer = "auto",
): Promise<RecordingEngine | undefined> {
  const audio = stream.getAudioTracks()[0];
  // Keep the established MediaRecorder audio path when track processing is
  // unavailable, instead of opening another AudioContext after the start gesture.
  for (const source of sources) {
    signal.throwIfAborted();
    if (
      audio &&
      !source.encodedAudio &&
      (typeof MediaStreamTrackProcessor !== "function" ||
        !(await canEncodeAudio("opus", {
          sampleRate:
            audio.getSettings().sampleRate ?? 48000,
          numberOfChannels:
            audio.getSettings().channelCount ?? 2,
          bitrate: 128000,
        })))
    )
      continue;
    const recorder = new EncodedRecording();
    try {
      await recorder.prepare(
        source,
        audio,
        signal,
        container,
      );
      return recorder;
    } catch {
      await recorder.dispose().catch(() => {});
      signal.throwIfAborted();
    }
  }
}
