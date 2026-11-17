import type { VideoSendFrameStats } from "@weblink/platform";

export const SEND_FRAME_MAX_AGE_MS = 1500;

/** Validate the same-frame contract before using browser or native snapshots. */
export function readSendFrameStats(
  value: unknown,
): VideoSendFrameStats | undefined {
  if (!value || typeof value !== "object") return;
  const s = value as VideoSendFrameStats;
  const valid = (n: unknown): n is number =>
    typeof n === "number" && Number.isFinite(n) && n >= 0;
  const uint32 = (n: unknown) =>
    valid(n) && Number.isInteger(n) && n <= 0xffffffff;
  if (
    !uint32(s.ssrc) ||
    !uint32(s.rtpTimestamp) ||
    !valid(s.ageMs) ||
    s.ageMs > SEND_FRAME_MAX_AGE_MS ||
    !valid(s.captureToPacketizerMs)
  )
    return;
  if (s.endpoint === "packetizer-input")
    return {
      ssrc: s.ssrc,
      rtpTimestamp: s.rtpTimestamp,
      ageMs: s.ageMs,
      captureToPacketizerMs: s.captureToPacketizerMs,
      endpoint: s.endpoint,
    };
  if (
    s.endpoint !== "transport-submit" ||
    !valid(s.packetizerToSendMs) ||
    !valid(s.captureToSendMs) ||
    Math.abs(
      s.captureToSendMs -
        s.captureToPacketizerMs -
        s.packetizerToSendMs,
    ) > 0.01
  )
    return;
  return { ...s };
}

/** The transform already exists for recording. Timing never copies payloads. */
export function browserSendFrameStats(
  metadata: {
    synchronizationSource?: number;
    rtpTimestamp?: number;
    captureTime?: number;
  },
  rtpTimestamp: number,
  now: number,
): VideoSendFrameStats | undefined {
  if (
    typeof metadata.captureTime !== "number" ||
    !Number.isFinite(metadata.captureTime) ||
    metadata.captureTime < 0 ||
    metadata.captureTime > now
  )
    return;
  return readSendFrameStats({
    ssrc: metadata.synchronizationSource,
    rtpTimestamp: metadata.rtpTimestamp ?? rtpTimestamp,
    captureToPacketizerMs: now - metadata.captureTime,
    ageMs: 0,
    endpoint: "packetizer-input",
  });
}
