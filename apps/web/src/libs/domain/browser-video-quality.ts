import {
  resolveVideoQuality,
  type VideoQualityLimits,
  type VideoQualityPreference,
  type VideoQualitySource,
} from "./video-quality";

export function browserQualitySource(
  track: MediaStreamTrack,
  mid: string,
  limits: VideoQualityLimits,
): VideoQualitySource {
  const settings = track.getSettings();
  return {
    id: `browser:${track.id}`,
    locator: `browser:${mid}`,
    transport: `${mid}:${track.id}`,
    limits: {
      maxWidth: Math.min(
        limits.maxWidth,
        settings.width || limits.maxWidth,
      ),
      maxHeight: Math.min(
        limits.maxHeight,
        settings.height || limits.maxHeight,
      ),
      frameRate: Math.min(
        limits.frameRate,
        Math.ceil(settings.frameRate || limits.frameRate),
      ),
      maxBitrate: limits.maxBitrate,
    },
  };
}

/** Never constrain the shared capture track when changing one viewer's encoding. */
export async function applyBrowserVideoQuality(
  sender: RTCRtpSender,
  source: VideoQualitySource,
  preference: VideoQualityPreference,
): Promise<VideoQualityLimits> {
  const track = sender.track;
  if (!track || track.readyState === "ended")
    throw new Error("Video source stopped");
  const applied = resolveVideoQuality(
    source.limits,
    preference,
  );
  const settings = track.getSettings();
  const width = settings.width || source.limits.maxWidth;
  const height = settings.height || source.limits.maxHeight;
  const scale = Math.max(
    1,
    width / applied.maxWidth,
    height / applied.maxHeight,
  );
  const parameters = sender.getParameters();
  if (!parameters.encodings?.length)
    throw new Error(
      "Video encoding parameters unavailable",
    );
  const previous = parameters.encodings.map((encoding) => ({
    ...encoding,
  }));
  for (const encoding of parameters.encodings) {
    encoding.scaleResolutionDownBy = scale;
    encoding.maxFramerate = applied.frameRate;
    encoding.maxBitrate = applied.maxBitrate;
  }
  await sender.setParameters(parameters);
  const actual = sender.getParameters();
  if (
    actual.encodings.some(
      (e) =>
        e.scaleResolutionDownBy !== scale ||
        e.maxFramerate !== applied.frameRate ||
        e.maxBitrate !== applied.maxBitrate,
    )
  ) {
    actual.encodings = previous;
    await sender.setParameters(actual);
    throw new Error(
      "Browser did not accept video quality parameters",
    );
  }
  return {
    ...applied,
    maxWidth: Math.floor(width / scale),
    maxHeight: Math.floor(height / scale),
  };
}
