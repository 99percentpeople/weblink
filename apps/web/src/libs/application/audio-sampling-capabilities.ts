import type { AudioCaptureFormat } from "@weblink/platform";
import {
  audioSampleRates,
  audioChannelCounts,
} from "./meeting-audio-settings";

/** null means the source did not disclose the capability, not that every value works. */
export interface AudioSamplingCapabilities {
  sampleRates: readonly number[] | null;
  channelCounts: readonly number[] | null;
}

export function audioSamplingCapabilities(
  capabilities: MediaTrackCapabilities,
  settings: MediaTrackSettings = {},
): AudioSamplingCapabilities {
  const values = (
    range: ULongRange | undefined,
    current: number | undefined,
    candidates: readonly number[],
  ) => {
    if (
      range &&
      Number.isFinite(range.min) &&
      Number.isFinite(range.max) &&
      range.min! <= range.max!
    ) {
      return candidates.filter(
        (value) =>
          value >= range.min! && value <= range.max!,
      );
    }
    // getSettings describes the active format only; do not invent a supported range.
    return current !== undefined &&
      candidates.includes(current)
      ? [current]
      : null;
  };
  return {
    sampleRates: values(
      capabilities.sampleRate,
      settings.sampleRate,
      audioSampleRates,
    ),
    channelCounts: values(
      capabilities.channelCount,
      settings.channelCount,
      audioChannelCounts,
    ),
  };
}

export function trackAudioSampling(
  track: MediaStreamTrack,
): AudioSamplingCapabilities {
  let capabilities: MediaTrackCapabilities = {};
  let settings: MediaTrackSettings = {};
  try {
    capabilities = track.getCapabilities?.() ?? {};
  } catch {
    /* Optional browser API. */
  }
  try {
    settings = track.getSettings?.() ?? {};
  } catch {
    /* An ended track can reject queries. */
  }
  return audioSamplingCapabilities(capabilities, settings);
}

export function browserAudioSampling(
  devices: readonly MediaDeviceInfo[],
  tracks: readonly MediaStreamTrack[],
  microphoneId: string,
): AudioSamplingCapabilities[] {
  const live = tracks.filter(
    (track) =>
      track.kind === "audio" &&
      track.readyState !== "ended",
  );
  const microphone = live.find((track) => {
    if (track.contentHint === "music") return false;
    try {
      return (
        !microphoneId ||
        track.getSettings?.().deviceId === microphoneId
      );
    } catch {
      return false;
    }
  });
  const inputs = devices.filter(
    (device) => device.kind === "audioinput",
  );
  const device = (
    microphoneId
      ? inputs.find(
          (device) => device.deviceId === microphoneId,
        )
      : (inputs.find(
          (device) => device.deviceId === "default",
        ) ?? inputs[0])
  ) as
    | (MediaDeviceInfo & {
        getCapabilities?(): MediaTrackCapabilities;
      })
    | undefined;
  let deviceCaps = audioSamplingCapabilities({});
  try {
    deviceCaps = audioSamplingCapabilities(
      device?.getCapabilities?.() ?? {},
    );
  } catch {
    /* Access may have been revoked. */
  }
  const trackCaps = microphone
    ? trackAudioSampling(microphone)
    : audioSamplingCapabilities({});
  return [
    {
      sampleRates:
        deviceCaps.sampleRates ?? trackCaps.sampleRates,
      channelCounts:
        deviceCaps.channelCounts ?? trackCaps.channelCounts,
    },
    ...live
      .filter((track) => track.contentHint === "music")
      .map(trackAudioSampling),
  ];
}

/** One preference serves the known sources; preserve native rate/channel pair constraints. */
export function audioSamplingChoices(
  browser: readonly AudioSamplingCapabilities[],
  nativeFormats: readonly AudioCaptureFormat[] | undefined,
  selected: {
    audioSampleRate: number | null;
    audioChannelCount: number | null;
  },
): AudioSamplingCapabilities {
  const intersect = (
    lists: readonly (readonly number[] | null)[],
  ): number[] | null => {
    const known = lists.filter(
      (list): list is readonly number[] => list !== null,
    );
    return known.length
      ? [...new Set(known[0])]
          .filter((value) =>
            known.every((list) => list.includes(value)),
          )
          .sort((a, b) => a - b)
      : null;
  };
  const formats = nativeFormats?.filter(
    (format) =>
      audioSampleRates.includes(
        format.sampleRate as (typeof audioSampleRates)[number],
      ) && audioChannelCounts.includes(format.channelCount),
  );
  return {
    sampleRates: intersect([
      ...browser.map((source) => source.sampleRates),
      formats
        ?.filter(
          (format) =>
            selected.audioChannelCount === null ||
            format.channelCount ===
              selected.audioChannelCount,
        )
        .map((format) => format.sampleRate) ?? null,
    ]),
    channelCounts: intersect([
      ...browser.map((source) => source.channelCounts),
      formats
        ?.filter(
          (format) =>
            selected.audioSampleRate === null ||
            format.sampleRate === selected.audioSampleRate,
        )
        .map((format) => format.channelCount) ?? null,
    ]),
  };
}
