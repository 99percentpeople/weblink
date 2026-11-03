import {
  mediaSignal,
  readMediaEnvelope,
  type MediaSignal,
} from "../media-signaling";
import type { ScreenControlSignal } from "./control-request";
export const NATIVE_SCREEN_CHANNEL =
  "weblink-desktop-media/1";
/** Screen reference sent in place of a dedicated SDP offer when roomTransport/1 is negotiated. */
export const ROOM_SCREEN_PREFIX = "weblink-room-track/";
export const MAX_NATIVE_SCREENS = 16;

export type ScreenSignal =
  | MediaSignal
  | ScreenControlSignal;
export function parseScreenSignal(
  data: unknown,
): ScreenSignal | undefined {
  const value = readMediaEnvelope(data);
  if (!value) return;
  const { type, id, sourceId } = value;
  if (
    type === "control-request" ||
    type === "control-cancel"
  )
    return { type, id };
  if (type === "control-result") {
    if (sourceId === undefined) return { type, id };
    if (
      typeof sourceId === "string" &&
      sourceId.length &&
      sourceId.length <= 128
    )
      return { type, id, sourceId };
    return;
  }
  return mediaSignal(value);
}
