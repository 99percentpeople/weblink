import type { AppOption } from "@/libs/state/app-options";

export const audioSampleRates = [
  8000, 16000, 32000, 44100, 48000,
] as const;
export const audioChannelCounts = [1, 2] as const;
export type MeetingAudioSettings = Partial<
  Pick<
    AppOption,
    | "audioSampleRate"
    | "audioChannelCount"
    | "nativeAudioCodec"
  >
>;

/** Old or malformed preferences must never prevent capture from starting. */
export function resolveAudioSampling(
  options: MeetingAudioSettings,
) {
  return {
    audioSampleRate:
      audioSampleRates.find(
        (rate) => rate === options.audioSampleRate,
      ) ?? null,
    audioChannelCount:
      audioChannelCounts.find(
        (count) => count === options.audioChannelCount,
      ) ?? null,
  };
}

/** Optional capture preferences allow devices to fall back to their supported format. */
export function meetingAudioConstraints(
  options: MeetingAudioSettings,
): MediaTrackConstraints {
  const { audioSampleRate, audioChannelCount } =
    resolveAudioSampling(options);
  return {
    ...(audioSampleRate === null
      ? {}
      : { sampleRate: { ideal: audioSampleRate } }),
    ...(audioChannelCount === null
      ? {}
      : { channelCount: { ideal: audioChannelCount } }),
  };
}

export function nativeAudioOptions(
  options: MeetingAudioSettings,
) {
  const sampling = resolveAudioSampling(options);
  return {
    audioSampleRate: sampling.audioSampleRate ?? 48000,
    audioChannelCount: sampling.audioChannelCount ?? 2,
    audioCodec: options.nativeAudioCodec ?? null,
  };
}

export function browserAudioCodecs(): string[] {
  try {
    return (
      RTCRtpSender.getCapabilities("audio")?.codecs.map(
        (codec) => codec.mimeType,
      ) ?? []
    );
  } catch {
    return [];
  }
}

export function audioCodecChoices(
  codecs: readonly string[],
): string[] {
  return [
    ...new Set(
      codecs.map((codec) => codec.trim().toLowerCase()),
    ),
  ]
    .filter(
      (codec) =>
        codec.startsWith("audio/") &&
        ![
          "audio/telephone-event",
          "audio/cn",
          "audio/red",
        ].includes(codec),
    )
    .sort();
}

export function audioCodecLabel(codec: string): string {
  const name = codec.replace(/^audio\//i, "");
  return (
    (
      {
        opus: "Opus",
        pcmu: "G.711 μ-law (PCMU)",
        pcma: "G.711 A-law (PCMA)",
        g722: "G.722",
      } as Record<string, string>
    )[name] ?? name.toUpperCase()
  );
}
