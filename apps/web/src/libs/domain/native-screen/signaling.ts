import type { ScreenControlSignal } from "./control-request";
import type { ControlCapabilities } from "../protocol/remote-control";

export const NATIVE_SCREEN_CHANNEL =
  "weblink-desktop-media";
export const MAX_NATIVE_SCREENS = 16;

export type ScreenSignal =
  | ScreenControlSignal
  | {
      type: "hello";
      receiveScreen: true;
      trickleIce?: true;
      multiScreen?: true;
      remoteControl?: ControlCapabilities;
      requestScreen?: true;
    }
  | {
      type: "offer";
      id: string;
      sourceId: string;
      control?: true;
      sdp: string;
      trickleIce?: true;
    }
  | { type: "answer"; id: string; sdp: string }
  | {
      type: "candidate";
      id: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: "stop"; id: string; retry?: true }
  | {
      type: "receiver-status";
      id: string;
      state: "healthy" | "unsupported";
    }
  | { type: "retry"; id: string };
export function parseScreenSignal(
  data: unknown,
): ScreenSignal | undefined {
  if (typeof data !== "string" || data.length > 65536)
    return;
  try {
    const value = JSON.parse(data);
    if (!value || typeof value !== "object") return;
    if (
      value.type === "hello" &&
      value.receiveScreen === true
    )
      return value;
    if (
      typeof value.id !== "string" ||
      !value.id.length ||
      value.id.length > 128
    )
      return;
    if (value.type === "stop" || value.type === "retry")
      return value;
    if (
      value.type === "receiver-status" &&
      (value.state === "healthy" ||
        value.state === "unsupported")
    )
      return value;
    if (
      value.type === "control-request" ||
      value.type === "control-cancel"
    )
      return value;
    if (value.type === "control-result") {
      if (
        value.sourceId === undefined ||
        (typeof value.sourceId === "string" &&
          value.sourceId.length > 0 &&
          value.sourceId.length <= 128)
      )
        return value;
      return;
    }
    if (value.type === "candidate") {
      const candidate = value.candidate;
      if (
        candidate &&
        typeof candidate.candidate === "string" &&
        candidate.candidate.length > 0 &&
        candidate.candidate.length <= 4096 &&
        (candidate.sdpMid == null ||
          (typeof candidate.sdpMid === "string" &&
            candidate.sdpMid.length <= 128)) &&
        (candidate.sdpMLineIndex == null ||
          (Number.isInteger(candidate.sdpMLineIndex) &&
            candidate.sdpMLineIndex >= 0 &&
            candidate.sdpMLineIndex <= 65535)) &&
        (candidate.sdpMid != null ||
          candidate.sdpMLineIndex != null)
      )
        return value;
      return;
    }
    if (
      typeof value.sdp !== "string" ||
      value.sdp.length > 60000
    )
      return;
    if (value.type === "answer") return value;
    if (
      value.type === "offer" &&
      typeof value.sourceId === "string" &&
      value.sourceId.length > 0 &&
      value.sourceId.length <= 128
    )
      return value;
  } catch {
    /* Ignore malformed or future control messages. */
  }
}
