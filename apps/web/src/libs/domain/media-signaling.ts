export type MediaSignal =
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
  | { type: "retry"; id: string; reason?: "decode" };
/** Media and screen control share an authenticated ordered channel and envelope bounds. */
export function readMediaEnvelope(data: unknown) {
  if (typeof data !== "string" || data.length > 65536)
    return;
  try {
    const value = JSON.parse(data);
    if (
      value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      value.id.length &&
      value.id.length <= 128
    ) {
      return value as Record<string, unknown> & {
        id: string;
      };
    }
  } catch {
    /* Ignore malformed or future signals. */
  }
}

export function mediaSignal(
  value: ReturnType<typeof readMediaEnvelope>,
): MediaSignal | undefined {
  if (!value) return;
  const { type, id } = value;
  if (type === "stop")
    return {
      type,
      id,
      ...(value.retry === true ? { retry: true } : {}),
    };
  if (type === "retry")
    return {
      type,
      id,
      ...(value.reason === "decode"
        ? { reason: "decode" }
        : {}),
    };
  if (
    type === "receiver-status" &&
    (value.state === "healthy" ||
      value.state === "unsupported")
  )
    return { type, id, state: value.state };
  if (type === "candidate") {
    const candidate = value.candidate as
      | RTCIceCandidateInit
      | undefined;
    if (
      candidate &&
      typeof candidate.candidate === "string" &&
      candidate.candidate.length &&
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
      return { type, id, candidate };
    return;
  }
  const { sdp, sourceId } = value;
  if (typeof sdp !== "string" || sdp.length > 60000) return;
  if (type === "answer") return { type, id, sdp };
  if (
    type === "offer" &&
    typeof sourceId === "string" &&
    sourceId.length &&
    sourceId.length <= 128
  ) {
    return {
      type,
      id,
      sdp,
      sourceId,
      ...(value.control === true ? { control: true } : {}),
      ...(value.trickleIce === true
        ? { trickleIce: true }
        : {}),
    };
  }
}
