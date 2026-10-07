/** Relative movement is a fraction of the shared display; wheel units are 120 per detent. */
export type TrackpadPan =
  | { phase: "start" | "end" | "cancel" }
  | {
      phase: "update";
      x: number;
      y: number;
      /** Cumulative contact-distance ratio, in [0.1, 4]; omitted means 1. */
      scale?: number;
    };
export type TrackpadEvent =
  | ({ type: "pan" } & TrackpadPan)
  | { type: "move"; x: number; y: number }
  | { type: "button"; button: number; down: boolean }
  | { type: "wheel"; horizontal: number; vertical: number };
