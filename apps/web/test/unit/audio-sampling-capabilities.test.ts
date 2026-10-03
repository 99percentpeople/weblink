import { expect, it } from "vitest";
import {
  audioSamplingCapabilities,
  audioSamplingChoices,
  browserAudioSampling,
  trackAudioSampling,
} from "@/libs/application/audio-sampling-capabilities";

const auto = {
  audioSampleRate: null,
  audioChannelCount: null,
};
it("filters app formats against the source's reported ranges", () => {
  expect(
    audioSamplingCapabilities({
      sampleRate: { min: 44100, max: 96000 },
      channelCount: { min: 2, max: 8 },
    }),
  ).toEqual({
    sampleRates: [44100, 48000],
    channelCounts: [2],
  });
});
it("keeps unknown ranges distinct from ranges with no supported app format", () => {
  expect(audioSamplingCapabilities({})).toEqual({
    sampleRates: null,
    channelCounts: null,
  });
  expect(
    audioSamplingCapabilities({
      sampleRate: { min: 96000, max: 192000 },
    }).sampleRates,
  ).toEqual([]);
});
it("uses only the active setting when capabilities are absent or malformed", () => {
  expect(
    audioSamplingCapabilities(
      { sampleRate: { min: NaN, max: 48000 } },
      { sampleRate: 44100, channelCount: 1 },
    ),
  ).toEqual({ sampleRates: [44100], channelCounts: [1] });
  expect(
    trackAudioSampling({
      getCapabilities: () => {
        throw new Error("revoked");
      },
      getSettings: () => ({ sampleRate: 48000 }),
    } as unknown as MediaStreamTrack),
  ).toEqual({ sampleRates: [48000], channelCounts: null });
});
it("reads the selected input and a live shared track without treating another mic as the selected source", () => {
  const devices = [
    {
      kind: "audioinput",
      deviceId: "selected",
      getCapabilities: () => ({
        sampleRate: { min: 44100, max: 48000 },
        channelCount: { min: 1, max: 2 },
      }),
    },
  ] as unknown as MediaDeviceInfo[];
  const tracks = [
    {
      kind: "audio",
      contentHint: "speech",
      getSettings: () => ({
        deviceId: "other",
        sampleRate: 8000,
      }),
    },
    {
      kind: "audio",
      contentHint: "music",
      getSettings: () => ({
        sampleRate: 48000,
        channelCount: 2,
      }),
    },
    {
      kind: "audio",
      contentHint: "music",
      readyState: "ended",
      getSettings: () => ({ sampleRate: 8000 }),
    },
  ] as unknown as MediaStreamTrack[];
  expect(
    audioSamplingChoices(
      browserAudioSampling(devices, tracks, "selected"),
      undefined,
      auto,
    ),
  ).toEqual({ sampleRates: [48000], channelCounts: [2] });
  expect(
    browserAudioSampling(
      [],
      tracks.slice(0, 1),
      "selected",
    )[0].sampleRates,
  ).toBeNull();
});
it("retains native rate/channel pairs instead of inventing their cross product", () => {
  const formats = [
    { sampleRate: 16000, channelCount: 1 },
    { sampleRate: 48000, channelCount: 2 },
  ] as const;
  expect(
    audioSamplingChoices([], formats, {
      audioSampleRate: 48000,
      audioChannelCount: 1,
    }),
  ).toEqual({ sampleRates: [16000], channelCounts: [2] });
  expect(audioSamplingChoices([], formats, auto)).toEqual({
    sampleRates: [16000, 48000],
    channelCounts: [1, 2],
  });
});
it("intersects known sources without treating undisclosed capabilities as supported values", () => {
  expect(
    audioSamplingChoices(
      [{ sampleRates: null, channelCounts: null }],
      undefined,
      auto,
    ),
  ).toEqual({ sampleRates: null, channelCounts: null });
  expect(
    audioSamplingChoices(
      [{ sampleRates: [44100], channelCounts: [1] }],
      [{ sampleRate: 48000, channelCount: 2 }],
      auto,
    ),
  ).toEqual({ sampleRates: [], channelCounts: [] });
});
