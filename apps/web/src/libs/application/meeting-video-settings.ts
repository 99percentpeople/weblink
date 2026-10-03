import {
  MAX_NATIVE_FRAME_RATE,
  type NativeScreenOptions,
} from "@weblink/platform";
import type { AppOption } from "@/libs/state/app-options";
import {
  nativeAudioOptions,
  type MeetingAudioSettings,
} from "./meeting-audio-settings";

export const videoResolutions = {
  "480p": [854, 480],
  "720p": [1280, 720],
  "1080p": [1920, 1080],
  "1440p": [2560, 1440],
  "2160p": [3840, 2160],
} as const;

export const defaultVideoFrameRates = [
  15, 24, 30, 60,
] as const;

/** Offer common rates and the displays' current rates, bounded by the fastest display. */
export function displayVideoFrameRates(
  refreshRates: readonly number[] = [],
): number[] {
  const rates = refreshRates.filter(
    (rate) =>
      Number.isInteger(rate) &&
      rate > 1 &&
      rate <= MAX_NATIVE_FRAME_RATE,
  );
  if (!rates.length) return [...defaultVideoFrameRates];
  const maximum = Math.max(...rates);
  return [
    ...new Set([
      ...defaultVideoFrameRates,
      90,
      120,
      144,
      165,
      180,
      240,
      360,
      480,
      ...rates,
    ]),
  ]
    .filter((rate) => rate <= maximum)
    .sort((a, b) => a - b);
}
export type MeetingVideoSettings = Pick<
  AppOption,
  | "videoResolution"
  | "videoFrameRate"
  | "videoMaxBitrate"
  | "nativeScreenCodec"
  | "degradationPreference"
> &
  Partial<
    Pick<
      AppOption,
      | "nativeScreenEncoder"
      | "nativeColorMatrix"
      | "nativeColorRange"
    >
  > &
  MeetingAudioSettings;

/** Treat persisted values as untrusted; keep the browser and native limits aligned. */
export function nativeScreenOptions(
  options: MeetingVideoSettings,
): NativeScreenOptions {
  const [maxWidth, maxHeight] = Object.hasOwn(
    videoResolutions,
    options.videoResolution,
  )
    ? videoResolutions[options.videoResolution]
    : videoResolutions["1080p"];
  return {
    ...nativeAudioOptions(options),
    maxWidth,
    maxHeight,
    frameRate: Number.isFinite(options.videoFrameRate)
      ? Math.max(
          1,
          Math.min(
            MAX_NATIVE_FRAME_RATE,
            Math.round(options.videoFrameRate),
          ),
        )
      : 30,
    maxBitrate: Number.isFinite(options.videoMaxBitrate)
      ? Math.max(
          128 * 1024,
          Math.min(
            150 * 1024 * 1024,
            Math.round(options.videoMaxBitrate),
          ),
        )
      : 25 * 1024 * 1024,
    codec: options.nativeScreenCodec ?? null,
    encoder: options.nativeScreenEncoder ?? "auto",
    colorMatrix:
      options.nativeScreenCodec === "video/vp8"
        ? "bt601"
        : options.nativeColorMatrix === "bt601" ||
            options.nativeColorMatrix === "bt709"
          ? options.nativeColorMatrix
          : "auto",
    colorRange:
      options.nativeScreenCodec !== "video/vp8" &&
      options.nativeColorRange === "full"
        ? "full"
        : "limited",
    degradationPreference: [
      "balanced",
      "maintain-framerate",
      "maintain-resolution",
    ].includes(options.degradationPreference)
      ? options.degradationPreference
      : "balanced",
  };
}

export function meetingVideoConstraints(
  options: MeetingVideoSettings,
): MediaTrackConstraints {
  const { maxWidth, maxHeight, frameRate } =
    nativeScreenOptions(options);
  return {
    width: { ideal: maxWidth, max: maxWidth },
    height: { ideal: maxHeight, max: maxHeight },
    frameRate: { ideal: frameRate, max: frameRate },
  };
}
