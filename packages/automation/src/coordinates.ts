/** Desktop pixels are already oriented and include negative multi-monitor origins. */
export interface DesktopBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface DesktopGeometry {
  coordinateSpace: "desktopPhysicalPixels";
  sourceId: string;
  geometryRevision: string;
  bounds: DesktopBounds;
  virtualBounds: DesktopBounds;
}
export interface ScreenshotResult extends DesktopGeometry {
  mimeType: "image/png";
  data: string;
  imageWidth: number;
  imageHeight: number;
  /** desktopX = imageX * scaleX + offsetX; likewise Y. Origin is the image's top-left edge. */
  imageToDesktop: {
    scaleX: number;
    scaleY: number;
    offsetX: number;
    offsetY: number;
  };
}
export interface ScreenshotArguments {
  target: string;
  /** Monitor or window source ID from screen.sources (not a UIA elementId). */
  sourceId: string;
  /** Fit within these limits, preserving aspect ratio; each defaults to 1024, max 2048. */
  maxWidth?: number;
  maxHeight?: number;
  /** Absolute desktopPhysicalPixels, wholly within the selected source; cropped before scaling. */
  rect?: DesktopBounds;
}
export interface PointerPoint {
  x: number;
  y: number;
}
export type PointerButton =
  | "left"
  | "right"
  | "middle"
  | "back"
  | "forward";
interface PointerTarget extends PointerPoint {
  target: string;
  coordinateSpace: "desktopPhysicalPixels";
  /** Native monitor source and layout revision returned by control.acquire. */
  sourceId: string;
  geometryRevision: string;
}
export type PointerArguments = PointerTarget &
  (
    | { action: "move"; path?: never; durationMs?: never }
    | {
        action: "move";
        path: PointerPoint[];
        durationMs?: number;
      }
    | {
        action: "drag";
        path: PointerPoint[];
        durationMs?: number;
        button?: PointerButton;
      }
    | { action: "down" | "up"; button?: PointerButton }
    | {
        action: "click";
        button?: PointerButton;
        clickCount?: 1 | 2;
        holdMs?: number;
        intervalMs?: number;
      }
    | { action: "scroll"; scrollX: number; scrollY: number }
  );
