import {
  EncodedAudioPacketSource,
  EncodedPacket,
} from "mediabunny";
import type {
  EncodedAudioPacket,
  EncodedVideoPacket,
} from "@/libs/domain/encoded-video";
import type { RecordingMuxerWrites } from "./recording-muxer-writes";

/** RFC 6716 section 3.1: packet duration, including multi-frame Opus packets. */
export function recordingOpusDuration(
  data: Uint8Array,
): number {
  if (!data.length) throw new Error("Empty Opus packet");
  const config = data[0] >> 3;
  const frame =
    config >= 16
      ? 2.5 * 2 ** (config & 3)
      : config >= 12
        ? 10 * 2 ** (config & 1)
        : [10, 20, 40, 60][config & 3];
  const code = data[0] & 3;
  const frames =
    code === 0 ? 1 : code === 3 ? (data[1] ?? 0) & 63 : 2;
  if (!frames || frames * frame > 120)
    throw new Error("Invalid Opus packet duration");
  return (frames * frame) / 1000;
}

export function recordingOpusConfig(
  packet: EncodedAudioPacket,
): AudioDecoderConfig {
  if (
    packet.mimeType.toLowerCase() !== "audio/opus" ||
    packet.sampleRate !== 48000 ||
    ![1, 2].includes(packet.channelCount) ||
    !Number.isFinite(packet.clockTime)
  )
    throw new Error(
      "Encoded audio codec or capture clock is unavailable",
    );
  recordingOpusDuration(new Uint8Array(packet.data));
  return {
    codec: "opus",
    sampleRate: 48000,
    numberOfChannels: packet.channelCount,
  };
}

/** Encoded audio and video have independent RTP origins. A shared capture or
 * receiver delivery clock aligns them; packet arrival time cannot establish lip sync. */
export class RecordingEncodedAudio {
  readonly source = new EncodedAudioPacketSource("opus");
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
    this.config = recordingOpusConfig(first);
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
    const config = recordingOpusConfig(packet);
    if (
      packet.ssrc !== this.first.ssrc ||
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
    const duration = recordingOpusDuration(bytes);
    // Opus packets cannot be trimmed without decoding. Skip the packet crossing the boundary.
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
