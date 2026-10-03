import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  audioCodecChoices,
  browserAudioCodecs,
  meetingAudioConstraints,
  nativeAudioOptions,
  resolveAudioSampling,
} from "@/libs/application/meeting-audio-settings";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import { getDefaultAppOptions } from "@/libs/state/app-options";

afterEach(() => vi.unstubAllGlobals());

describe("audio capture preferences", () => {
  it("keeps device defaults and native 48 kHz stereo for automatic and legacy settings", () => {
    expect(meetingAudioConstraints({})).toEqual({});
    expect(nativeAudioOptions({})).toEqual({
      audioSampleRate: 48000,
      audioChannelCount: 2,
      audioCodec: null,
    });
  });
  it("requests optional browser constraints and forwards native sampling and codec without enabling audio", () => {
    const options = {
      ...getDefaultAppOptions(),
      audioSampleRate: 16000,
      audioChannelCount: 1 as const,
      preferredAudioCodec: "audio/pcma",
      nativeAudioCodec: "audio/opus",
    };
    expect(meetingAudioConstraints(options)).toEqual({
      sampleRate: { ideal: 16000 },
      channelCount: { ideal: 1 },
    });
    const native = nativeScreenOptions(options);
    expect(native).toMatchObject({
      audioSampleRate: 16000,
      audioChannelCount: 1,
      audioCodec: "audio/opus",
    });
    expect(native.audio).toBeUndefined();
  });
  it.each([NaN, Infinity, -1, 0, 96000, "48000"])(
    "sanitizes invalid saved sampling values (%s)",
    (value) => {
      const options = {
        audioSampleRate: value,
        audioChannelCount: value,
      } as any;
      expect(resolveAudioSampling(options)).toEqual({
        audioSampleRate: null,
        audioChannelCount: null,
      });
      expect(meetingAudioConstraints(options)).toEqual({});
    },
  );
  it("does not present RTP repair, comfort noise, or DTMF as audio encoders", () => {
    expect(
      audioCodecChoices([
        "audio/Opus",
        "audio/opus",
        "audio/PCMA",
        "audio/red",
        "audio/CN",
        "audio/telephone-event",
        "video/VP9",
      ]),
    ).toEqual(["audio/opus", "audio/pcma"]);
  });
  it("handles missing and failing codec capability discovery", () => {
    vi.stubGlobal("RTCRtpSender", undefined);
    expect(browserAudioCodecs()).toEqual([]);
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => {
        throw new Error("Unavailable");
      },
    });
    expect(browserAudioCodecs()).toEqual([]);
  });
});
