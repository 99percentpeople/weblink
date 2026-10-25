const controlNames = new Set([
  "encodingPreset",
  "nvencPreset",
  "nvencTuning",
  "spatialAQ",
  "qualityVsSpeed",
]);

/** Preserve bounded metrics and known control names, never arbitrary native strings. */
export function sanitizePipeline(
  value: unknown,
  depth = 0,
  key?: string,
): unknown {
  if (depth > 6) return undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean" || value === null)
    return value;
  if (typeof value === "string") {
    if (key === "name" && controlNames.has(value))
      return value;
    return value.match(/0x[0-9a-f]{8}/gi) ?? undefined;
  }
  if (Array.isArray(value))
    return value
      .slice(0, 32)
      .map((v) => sanitizePipeline(v, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 64)
        .map(([k, v]) => [
          k,
          sanitizePipeline(v, depth + 1, k),
        ]),
    );
  return undefined;
}
