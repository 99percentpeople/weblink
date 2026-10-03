export const MAX_TOUCH_CONTACTS = 10;
export type TouchPhase =
  | "down"
  | "update"
  | "up"
  | "cancel";
export interface TouchSample {
  x: number;
  y: number;
  /** Browser-reported pressure, normalized to [0, 1]. */
  pressure?: number;
  /** Contact dimensions as fractions of the displayed video content. */
  width?: number;
  height?: number;
}
export interface TouchContact extends TouchSample {
  id: number;
  phase: TouchPhase;
}
