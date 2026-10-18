/** Keep screen detail instead of using the recorder's fixed default at every resolution. */
export function recordingVideoBitrate(
  settings: MediaTrackSettings = {},
): number {
  const positive = (
    value: number | undefined,
    fallback: number,
  ) =>
    value !== undefined &&
    Number.isFinite(value) &&
    value > 0
      ? value
      : fallback;
  // Remote/native tracks may not expose dimensions before their first frame.
  const width = positive(settings.width, 1920);
  const height = positive(settings.height, 1080);
  const frameRate = Math.min(
    60,
    Math.max(30, positive(settings.frameRate, 30)),
  );
  // A target, not a guaranteed file size: MediaRecorder still uses variable bitrate.
  return Math.min(
    40_000_000,
    Math.max(
      2_500_000,
      Math.round(
        (width * height * frameRate * 0.16) / 100_000,
      ) * 100_000,
    ),
  );
}

/** Automatic recording can pass remote H.264 through in Matroska, not WebM. */
export function recordingFormat(type: string): {
  type: string;
  extension: "webm" | "mkv" | "mp4";
} {
  const container = type
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  switch (container) {
    case "video/webm":
      return { type, extension: "webm" };
    case "video/x-matroska":
    case "video/matroska":
      return { type, extension: "mkv" };
    case "video/mp4":
      return { type, extension: "mp4" };
    default:
      throw new Error(
        `Unsupported recording format: ${type || "unknown"}`,
      );
  }
}
export type RecordingContainer = "auto" | "mkv" | "mp4";

/** Select a container that preserves the actual codecs, independently of capture or storage. */
export function recordingContainerForCodec(
  preference: RecordingContainer,
  codec: string,
  audioCodec?: string,
): "mkv" | "mp4" {
  if (
    preference === "auto" &&
    audioCodec &&
    ["g722", "ulaw", "alaw"].includes(audioCodec)
  )
    return "mkv";
  return preference === "auto"
    ? codec === "avc" || codec === "hevc"
      ? "mp4"
      : "mkv"
    : preference;
}

export function resolveRecordingContainer(
  value: unknown,
): RecordingContainer {
  return value === "mkv" || value === "mp4"
    ? value
    : "auto";
}
