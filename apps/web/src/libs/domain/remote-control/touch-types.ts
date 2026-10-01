export const MAX_TOUCH_CONTACTS = 10;
export type TouchPhase =
  | "down"
  | "update"
  | "up"
  | "cancel";
export interface TouchContact {
  id: number;
  x: number;
  y: number;
  phase: TouchPhase;
}
