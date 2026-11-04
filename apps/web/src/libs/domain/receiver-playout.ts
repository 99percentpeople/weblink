import type { RoomReceiver } from "@weblink/platform";

/** Apply interactive playout to browser receivers without requiring optional setters. */
export function setInteractivePlayout(
  receiver: RoomReceiver,
): void {
  const hints = receiver as RoomReceiver & {
    jitterBufferTarget?: number | null;
    playoutDelayHint?: number;
  };
  for (const key of [
    "jitterBufferTarget",
    "playoutDelayHint",
  ] as const) {
    try {
      if (key in hints) hints[key] = 0;
    } catch {
      // A browser may expose a setter without supporting it.
    }
  }
}
