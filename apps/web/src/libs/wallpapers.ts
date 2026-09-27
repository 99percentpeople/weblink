const ink =
  "color-mix(in srgb, var(--foreground) 18%, transparent)";
const fineInk =
  "color-mix(in srgb, var(--foreground) 9%, transparent)";

export const wallpaperPresets = [
  {
    id: "dots",
    image: `radial-gradient(circle, ${ink} 1px, transparent 1.5px)`,
    size: "18px 18px",
  },
  {
    id: "grid",
    image: `linear-gradient(${ink} 1px, transparent 1px), linear-gradient(90deg, ${ink} 1px, transparent 1px)`,
    size: "28px 28px",
  },
  {
    id: "diagonal",
    image: `repeating-linear-gradient(135deg, ${ink} 0 1px, transparent 1px 12px)`,
    size: "auto",
  },
  {
    id: "linen",
    image: `repeating-linear-gradient(0deg, ${fineInk} 0 1px, transparent 1px 4px), repeating-linear-gradient(90deg, ${fineInk} 0 1px, transparent 1px 6px)`,
    size: "auto",
  },
  {
    id: "waves",
    image: `radial-gradient(ellipse at 50% 100%, transparent 60%, ${ink} 61% 64%, transparent 65%)`,
    size: "40px 20px",
  },
  {
    id: "checker",
    image: `repeating-conic-gradient(${fineInk} 0% 25%, transparent 0% 50%)`,
    size: "28px 28px",
  },
] as const;

export type WallpaperPresetId =
  (typeof wallpaperPresets)[number]["id"];

export const getWallpaperPreset = (id?: string) =>
  wallpaperPresets.find((preset) => preset.id === id);

export function resolveWallpaper(
  presetId?: string,
  imageUrl?: string,
): { image: string; size: string; repeat: string } {
  const preset = getWallpaperPreset(presetId);
  if (preset) return { ...preset, repeat: "repeat" };
  return {
    image: imageUrl ? `url("${imageUrl}")` : "none",
    size: "cover",
    repeat: "no-repeat",
  };
}
