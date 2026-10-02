import { getInitials } from "./name";

const fallbackImages = new Map<string, string>();
const avatarFontFamily = "system-ui, sans-serif";

const hashAvatarSeed = (seed: string) => {
  let hash = 2166136261;

  for (const char of seed.trim().toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
};

export const getAvatarFallbackColors = (
  seed: string,
): [string, string] => {
  const hash = hashAvatarSeed(seed);
  const hue = hash % 360;
  const secondHue = (hue + 32 + ((hash >>> 8) % 56)) % 360;
  const saturation = 58 + ((hash >>> 16) % 13);
  const lightness = 43 + ((hash >>> 24) % 6);

  return [
    `hsl(${hue} ${saturation}% ${lightness}%)`,
    `hsl(${secondHue} ${Math.max(52, saturation - 6)}% ${Math.max(36, lightness - 7)}%)`,
  ];
};

/** Shared vector source for UI avatars and rasterized system notification icons. */
export function getAvatarFallbackSvg(name: string): string {
  const size = 128;
  const initials = getInitials(name).replace(
    /[\u0000-\u001F\uD800-\uDFFF\uFFFE\uFFFF]/gu,
    "\uFFFD",
  );
  let fontSize = size * 0.4;
  let x = size / 2;
  let y = size / 2;
  let anchor = "middle";
  let baseline = "central";
  // Measure visible glyph bounds, rather than the font's line box. The SVG itself
  // stays vector; no canvas drawing is used for the UI avatar.
  if (typeof CanvasRenderingContext2D !== "undefined") {
    try {
      const context = document
        .createElement("canvas")
        .getContext("2d");
      if (context) {
        context.font = `600 ${fontSize}px ${avatarFontFamily}`;
        context.textAlign = "left";
        context.textBaseline = "alphabetic";
        let bounds = context.measureText(initials);
        const width =
          bounds.actualBoundingBoxLeft +
          bounds.actualBoundingBoxRight;
        const height =
          bounds.actualBoundingBoxAscent +
          bounds.actualBoundingBoxDescent;
        const scale = Math.min(
          1,
          (size * 0.78) / Math.max(width, height),
        );
        if (scale < 1) {
          fontSize *= scale;
          context.font = `600 ${fontSize}px ${avatarFontFamily}`;
          bounds = context.measureText(initials);
        }
        const measuredX =
          (size +
            bounds.actualBoundingBoxLeft -
            bounds.actualBoundingBoxRight) /
          2;
        const measuredY =
          (size +
            bounds.actualBoundingBoxAscent -
            bounds.actualBoundingBoxDescent) /
          2;
        if (
          Number.isFinite(measuredX) &&
          Number.isFinite(measuredY)
        ) {
          x = measuredX;
          y = measuredY;
          anchor = "start";
          baseline = "alphabetic";
        }
      }
    } catch {
      // SVG's native baseline remains available if text measurement is blocked.
    }
  }
  const [start, end] = getAvatarFallbackColors(name);
  const text = initials
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
<defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${start}"/><stop offset="1" stop-color="${end}"/></linearGradient></defs>
<circle cx="64" cy="64" r="64" fill="url(#background)"/>
<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="${baseline}" font-family="${avatarFontFamily}" font-size="${fontSize}" font-weight="600" fill="white">${text}</text>
</svg>`;
}

export function getAvatarFallbackImage(
  name: string,
): string {
  const cached = fallbackImages.get(name);
  if (cached) return cached;
  const image = `data:image/svg+xml,${encodeURIComponent(getAvatarFallbackSvg(name))}`;
  if (fallbackImages.size >= 128)
    fallbackImages.delete(
      fallbackImages.keys().next().value!,
    );
  fallbackImages.set(name, image);
  return image;
}
