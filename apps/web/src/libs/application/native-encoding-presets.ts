import type {
  NativeEncoder,
  NativeEncodingPreset,
} from "@weblink/platform";

export const nativeEncodingPresets = [
  "balanced",
  "quality",
  "latency",
] as const satisfies readonly NativeEncodingPreset[];

export function resolveEncodingPreset(
  value: unknown,
): NativeEncodingPreset {
  return value === "quality" || value === "latency"
    ? value
    : "balanced";
}

/** Bound persisted preferences and discard unknown keys and values. */
export function resolveEncoderPresets(
  value: unknown,
): Record<string, NativeEncodingPreset> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([id, preset]) =>
          (id === "auto" ||
            id === "software" ||
            /^nvenc:h26[45]$/.test(id) ||
            (id.startsWith("mf:") && id.length <= 64)) &&
          nativeEncodingPresets.some(
            (entry) => entry === preset,
          ),
      )
      .slice(0, 128),
  );
}

export function supportedEncodingPresets(
  encoders: readonly NativeEncoder[],
  encoder: string,
): NativeEncodingPreset[] {
  const available = encoders.filter(
    (item) => encoder === "auto" || item.id === encoder,
  );
  return nativeEncodingPresets.filter((preset) =>
    available.some((item) =>
      item.presets?.includes(preset),
    ),
  );
}
