import type { EncodedAudioPacket } from "@/libs/domain/encoded-video";

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
