import type { JSX } from "solid-js";

const hashAvatarSeed = (seed: string) => {
  let hash = 2166136261;

  for (const char of seed.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

export const getAvatarFallbackStyle = (
  seed: string,
): JSX.CSSProperties => {
  const hash = hashAvatarSeed(seed);
  const hue = hash % 360;
  const secondHue = (hue + 32 + ((hash >>> 8) % 56)) % 360;
  const saturation = 58 + ((hash >>> 16) % 13);
  const lightness = 43 + ((hash >>> 24) % 6);

  return {
    background: `linear-gradient(135deg, hsl(${hue} ${saturation}% ${lightness}%), hsl(${secondHue} ${Math.max(52, saturation - 6)}% ${Math.max(36, lightness - 7)}%))`,
    color: "white",
    "font-weight": "600",
    "letter-spacing": "0.02em",
  };
};
