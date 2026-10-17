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
