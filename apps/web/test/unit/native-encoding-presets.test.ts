import { describe, expect, it } from "vitest";
import type { NativeEncoder } from "@weblink/platform";
import { supportedEncodingPresets } from "@/libs/application/native-encoding-presets";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import { resolveStoredAppOptions } from "@/libs/state/stored-app-options";

const encoders: NativeEncoder[] = [
  {
    id: "nvenc:h265",
    name: "NVENC",
    hardware: true,
    codecs: ["video/h265"],
    presets: ["balanced", "quality", "latency"],
  },
  {
    id: "mf:partial",
    name: "MFT",
    hardware: true,
    codecs: ["video/h264"],
    presets: ["balanced", "latency"],
  },
  {
    id: "software",
    name: "Software",
    hardware: false,
    codecs: ["video/vp8"],
    presets: ["balanced", "quality", "latency"],
  },
];
describe("native encoding presets", () => {
  it("only exposes probed capabilities, including automatic selection", () => {
    expect(
      supportedEncodingPresets(encoders, "auto"),
    ).toEqual(["balanced", "quality", "latency"]);
    expect(
      supportedEncodingPresets(encoders, "mf:partial"),
    ).toEqual(["balanced", "latency"]);
    expect(
      supportedEncodingPresets(encoders, "software"),
    ).toEqual(["balanced", "quality", "latency"]);
    expect(
      supportedEncodingPresets(encoders, "missing"),
    ).toEqual([]);
    expect(
      supportedEncodingPresets(
        [{ ...encoders[0], presets: undefined }],
        "auto",
      ),
    ).toEqual([]);
  });
  it("remembers each encoder independently without changing stream limits", () => {
    const options = resolveStoredAppOptions({
      videoFrameRate: 120,
      videoResolution: "1440p",
      videoMaxBitrate: 150 * 1024 * 1024,
      nativeEncoderPresets: {
        auto: "latency",
        "nvenc:h265": "quality",
        "mf:partial": "balanced",
        software: "latency",
      },
    });
    for (const [encoder, preset] of [
      ["auto", "latency"],
      ["nvenc:h265", "quality"],
      ["mf:partial", "balanced"],
      ["software", "latency"],
    ]) {
      expect(
        nativeScreenOptions({
          ...options,
          nativeScreenEncoder: encoder,
        }),
      ).toMatchObject({
        encoder,
        encodingPreset: preset,
        frameRate: 120,
        maxWidth: 2560,
        maxHeight: 1440,
        maxBitrate: 150 * 1024 * 1024,
      });
    }
    expect(
      resolveStoredAppOptions(options).nativeEncoderPresets,
    ).toEqual(options.nativeEncoderPresets);
  });
  it("defaults legacy settings and sanitizes malformed saved presets", () => {
    expect(
      nativeScreenOptions(resolveStoredAppOptions({}))
        .encodingPreset,
    ).toBe("balanced");
    for (const value of [null, [], 42, "quality"]) {
      expect(
        resolveStoredAppOptions({
          nativeEncoderPresets: value,
        }).nativeEncoderPresets,
      ).toEqual({});
    }
    expect(
      resolveStoredAppOptions({
        nativeEncoderPresets: JSON.parse(
          '{"auto":"quality","__proto__":"latency","nvenc:h264":"broken","software":"quality","mf:valid":"latency"}',
        ),
      }).nativeEncoderPresets,
    ).toEqual({
      auto: "quality",
      software: "quality",
      "mf:valid": "latency",
    });
  });
});
