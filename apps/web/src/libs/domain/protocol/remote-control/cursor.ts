/** Host cursor snapshots use only known CSS names or bounded PNGs, never remote URLs. */
export const MAX_CURSOR_MESSAGE_BYTES = 24 * 1024;
export const MAX_CURSOR_PNG_BYTES = 16 * 1024;
export const MAX_CURSOR_SIZE = 128;
export const CURSOR_NAMES = [
  "default",
  "text",
  "pointer",
  "crosshair",
  "wait",
  "progress",
  "help",
  "not-allowed",
  "move",
  "ns-resize",
  "ew-resize",
  "nesw-resize",
  "nwse-resize",
  "none",
] as const;
export type RemoteCursorShape =
  | { type: "unknown" }
  | { type: "system"; name: (typeof CURSOR_NAMES)[number] }
  | {
      type: "image";
      png: string;
      width: number;
      height: number;
      hotspotX: number;
      hotspotY: number;
    };

export function parseRemoteCursorShape(
  value: unknown,
): RemoteCursorShape | undefined {
  if (!value || typeof value !== "object") return;
  const v = value as Record<string, unknown>;
  if (v.type === "unknown") return { type: "unknown" };
  if (
    v.type === "system" &&
    CURSOR_NAMES.some((name) => name === v.name)
  )
    return {
      type: "system",
      name: v.name as (typeof CURSOR_NAMES)[number],
    };
  const { width, height, hotspotX, hotspotY, png } = v;
  if (
    v.type !== "image" ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width < 1 ||
    width > MAX_CURSOR_SIZE ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < 1 ||
    height > MAX_CURSOR_SIZE ||
    typeof hotspotX !== "number" ||
    !Number.isInteger(hotspotX) ||
    hotspotX < 0 ||
    hotspotX >= width ||
    typeof hotspotY !== "number" ||
    !Number.isInteger(hotspotY) ||
    hotspotY < 0 ||
    hotspotY >= height ||
    typeof png !== "string" ||
    png.length < 44 ||
    png.length > Math.ceil(MAX_CURSOR_PNG_BYTES / 3) * 4 ||
    png.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(png)
  )
    return;
  // Check the PNG header before allowing the browser to allocate decoded pixels.
  const bytes = atob(png);
  if (
    bytes.length > MAX_CURSOR_PNG_BYTES ||
    bytes.slice(0, 8) !== "\x89PNG\r\n\x1a\n" ||
    bytes.slice(8, 16) !== "\0\0\0\rIHDR"
  )
    return;
  const u32 = (offset: number) =>
    bytes.charCodeAt(offset) * 0x1000000 +
    (bytes.charCodeAt(offset + 1) << 16) +
    (bytes.charCodeAt(offset + 2) << 8) +
    bytes.charCodeAt(offset + 3);
  if (u32(16) !== width || u32(20) !== height) return;
  return {
    type: "image",
    png,
    width,
    height,
    hotspotX,
    hotspotY,
  };
}
