/** RTP clocks and decoded sample rates differ for G.722 (RFC 3551, section 4.5.2). */
export const RECORDING_AUDIO_CODECS = [
  {
    id: 1,
    codec: "opus",
    mimeType: "audio/opus",
    sampleRate: 48000,
    clockRate: 48000,
    channels: 2,
  },
  {
    id: 2,
    codec: "g722",
    mimeType: "audio/g722",
    sampleRate: 16000,
    clockRate: 8000,
    channels: 1,
  },
  {
    id: 3,
    codec: "ulaw",
    mimeType: "audio/pcmu",
    sampleRate: 8000,
    clockRate: 8000,
    channels: 1,
  },
  {
    id: 4,
    codec: "alaw",
    mimeType: "audio/pcma",
    sampleRate: 8000,
    clockRate: 8000,
    channels: 1,
  },
] as const;

export type RecordingEncodedAudioFormat =
  (typeof RECORDING_AUDIO_CODECS)[number] & {
    channelCount: number;
  };

export function recordingAudioFormat(
  mimeType: string,
  clockRate?: number,
  channelCount?: number,
): RecordingEncodedAudioFormat | undefined {
  const format = RECORDING_AUDIO_CODECS.find(
    (value) => value.mimeType === mimeType.toLowerCase(),
  );
  if (!format) return;
  const channels = channelCount ?? format.channels;
  if (
    (clockRate !== undefined &&
      clockRate !== format.clockRate) ||
    !Number.isInteger(channels) ||
    channels < 1 ||
    channels > format.channels
  )
    return;
  return { ...format, channelCount: channels };
}
