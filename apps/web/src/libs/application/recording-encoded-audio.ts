import {
  EncodedAudioPacketSource,
  EncodedPacket,
} from "mediabunny";
import { recordingAudioFormat } from "@weblink/platform";
import type {
  EncodedAudioPacket,
  EncodedVideoPacket,
} from "@/libs/domain/encoded-video";
import type { RecordingMuxerWrites } from "./recording-muxer-writes";
import {
  recordingOpusConfig,
  recordingOpusDuration,
} from "./recording-opus";

export function recordingEncodedAudioDuration(
  packet: EncodedAudioPacket,
): number {
  const format = recordingAudioFormat(
    packet.mimeType,
    packet.clockRate,
    packet.channelCount,
  );
  if (!format)
    throw new Error("Unsupported encoded audio format");
  if (format.codec === "opus")
    return recordingOpusDuration(
      new Uint8Array(packet.data),
    );
  // RFC 3551: G.722's 64 kbit/s payload has two 16 kHz samples per byte.
  // PCMA/PCMU have one 8 kHz sample per byte. All three RTP formats are mono.
  if (!packet.data.byteLength)
    throw new Error("Empty encoded audio packet");
  return packet.data.byteLength / 8000;
}

export function recordingEncodedAudioConfig(
  packet: EncodedAudioPacket,
): AudioDecoderConfig {
  const format = recordingAudioFormat(
    packet.mimeType,
    packet.clockRate,
    packet.channelCount,
  );
  if (
    !format ||
    format.sampleRate !== packet.sampleRate ||
    !Number.isFinite(packet.clockTime)
  )
    throw new Error(
      "Encoded audio codec or capture clock is unavailable",
    );
  if (format.codec === "opus")
    return recordingOpusConfig(packet);
  recordingEncodedAudioDuration(packet);
  return {
    codec: format.codec,
    sampleRate: format.sampleRate,
    numberOfChannels: packet.channelCount,
  };
}

/** Encoded audio and video have independent RTP origins. A shared capture or
 * receiver delivery clock aligns them; packet arrival time cannot establish lip sync. */
export class RecordingEncodedAudio {
  readonly source: EncodedAudioPacketSource;
  readonly codec: NonNullable<
    ReturnType<typeof recordingAudioFormat>
  >["codec"];
  readonly config: AudioDecoderConfig;
  end = 0;
  private segment = -1;
  private origin = 0;
  private time = 0;
  private pending: EncodedAudioPacket[] = [];
  private bytes = 0;
  private queue = Promise.resolve();
  constructor(
    private readonly first: EncodedAudioPacket,
    private readonly writes: RecordingMuxerWrites,
  ) {
    this.config = recordingEncodedAudioConfig(first);
    this.codec = recordingAudioFormat(
      first.mimeType,
    )!.codec;
    this.source = new EncodedAudioPacketSource(this.codec);
  }
  startSegment(
    video: EncodedVideoPacket,
    timestamp: number,
  ): void {
    if (!Number.isFinite(video.clockTime))
      throw new Error("Video capture clock disappeared");
    this.segment = video.segment;
    this.origin = video.clockTime!;
    this.time = timestamp;
    const pending = this.pending;
    this.pending = [];
    this.bytes = 0;
    for (const packet of pending) this.schedule(packet);
  }
  add(packet: EncodedAudioPacket): Promise<void> {
    const config = recordingEncodedAudioConfig(packet);
    if (
      packet.ssrc !== this.first.ssrc ||
      config.codec !== this.config.codec ||
      config.sampleRate !== this.config.sampleRate ||
      config.numberOfChannels !==
        this.config.numberOfChannels
    )
      throw new Error(
        "Encoded audio source or format changed",
      );
    if (packet.segment < this.segment) return this.queue;
    if (packet.segment > this.segment) {
      // Audio often arrives before the requested video keyframe. Keep only a bounded prefix.
      if (
        this.pending.length >= 256 ||
        this.bytes + packet.data.byteLength > 512 * 1024
      )
        throw new Error(
          "Recording audio is waiting too long for a video keyframe",
        );
      this.pending.push(packet);
      this.bytes += packet.data.byteLength;
      return this.queue;
    }
    this.schedule(packet);
    return this.queue;
  }
  private schedule(packet: EncodedAudioPacket) {
    if (packet.segment !== this.segment) return;
    const timestamp =
      this.time + (packet.clockTime! - this.origin) / 1000;
    const bytes = new Uint8Array(packet.data);
    const duration = recordingEncodedAudioDuration(packet);
    // Encoded packets cannot be trimmed without decoding. Skip the packet crossing the boundary.
    if (timestamp < 0 || timestamp < this.end - 0.002)
      return;
    this.end = timestamp + duration;
    this.writes.accountPacket(bytes.length);
    this.queue = this.queue.then(() =>
      this.source.add(
        new EncodedPacket(
          bytes,
          "key",
          timestamp,
          duration,
        ),
        { decoderConfig: this.config },
      ),
    );
    // The caller/finish observes the rejection; never leave an unhandled task between frames.
    void this.queue.catch(() => {});
  }
  finish(): Promise<void> {
    return this.queue;
  }
}
