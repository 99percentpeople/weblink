/** Host cursor snapshots use only known CSS names or bounded PNGs, never remote URLs. */
export const MAX_CURSOR_MESSAGE_BYTES = 24 * 1024;
export const MAX_CURSOR_PNG_BYTES = 16 * 1024;
export const MAX_CURSOR_SIZE = 128;
export type RemoteCursorOwner = "host" | "viewer";
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
export type RemoteCursorImage = {
  type: "image";
  png: string;
  /** Native PNG dimensions and hotspot in source pixels; never pre-shrunk for transmission. */
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
  /** Host monitor scaling in percent. CSS size = source pixels * 100 / sourceScale. */
  sourceScale: number;
};
export function cursorGeometry(image: RemoteCursorImage): {
  width: number;
  height: number;
  hotspotX: number;
  hotspotY: number;
} {
  return {
    width: (image.width * 100) / image.sourceScale,
    height: (image.height * 100) / image.sourceScale,
    hotspotX: (image.hotspotX * 100) / image.sourceScale,
    hotspotY: (image.hotspotY * 100) / image.sourceScale,
  };
}
export type RemoteCursorFrame = {
  image: RemoteCursorImage;
  durationMs: number;
};
export type RemoteCursorShape =
  | { type: "unknown" }
  | { type: "system"; name: (typeof CURSOR_NAMES)[number] }
  | RemoteCursorImage
  // Assembled from bounded cursor-asset packets, never parsed as one large message.
  | { type: "animation"; frames: RemoteCursorFrame[] };

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
  const {
    width,
    height,
    hotspotX,
    hotspotY,
    png,
    sourceScale,
  } = v;
  if (
    v.type !== "image" ||
    typeof sourceScale !== "number" ||
    !Number.isInteger(sourceScale) ||
    sourceScale < 100 ||
    sourceScale > 500 ||
    typeof width !== "number" ||
    !Number.isInteger(width) ||
    width < 1 ||
    width * 100 > MAX_CURSOR_SIZE * sourceScale ||
    typeof height !== "number" ||
    !Number.isInteger(height) ||
    height < 1 ||
    height * 100 > MAX_CURSOR_SIZE * sourceScale ||
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
    sourceScale,
  };
}
