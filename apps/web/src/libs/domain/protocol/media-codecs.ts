/** Additive hello capability. null means discovery unavailable, [] means no codec. */
export interface MediaDecodeCapabilities {
  video: string[] | null;
  audio: string[] | null;
}

export const VIDEO_CODECS = [
  "video/av1",
  "video/h265",
  "video/vp9",
  "video/h264",
  "video/vp8",
] as const;
export const AUDIO_CODECS = [
  "audio/opus",
  "audio/g722",
  "audio/pcmu",
  "audio/pcma",
] as const;

export function parseMediaDecodeCapabilities(
  value: unknown,
): MediaDecodeCapabilities | undefined {
  if (!value || typeof value !== "object") return;
  const candidate = value as Record<string, unknown>;
  const parse = (
    kind: "audio" | "video",
  ): string[] | null | undefined => {
    const list = candidate[kind];
    if (list === null) return null;
    if (
      !Array.isArray(list) ||
      list.length > 32 ||
      list.some(
        (item) =>
          typeof item !== "string" ||
          item.length > 64 ||
          !new RegExp(`^${kind}/[a-zA-Z0-9.-]+$`).test(
            item,
          ),
      )
    )
      return;
    return [
      ...new Set(list.map((item) => item.toLowerCase())),
    ];
  };
  const video = parse("video");
  const audio = parse("audio");
  if (video !== undefined && audio !== undefined)
    return { video, audio };
}
