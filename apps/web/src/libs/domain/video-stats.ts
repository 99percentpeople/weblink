/** Cumulative counters. Times use seconds; sample timestamps use milliseconds. */
export interface VideoStatsSample {
  id: string;
  timestamp: number;
  codec?: string;
  implementation?: string;
  width?: number;
  height?: number;
  bytes?: number;
  frames?: number;
  encodeFrames?: number;
  encodeSeconds?: number;
  decodeSeconds?: number;
  jitterSeconds?: number;
  jitterFrames?: number;
  encoderQueueSeconds?: number;
  captureToEncodeSeconds?: number;
  freshFrames?: number;
  packetsSent?: number;
  sendDelaySeconds?: number;
  roundTripSeconds?: number;
}

export interface VideoStatsBatch {
  key: object | string;
  direction: "send" | "receive";
  preview?: boolean;
  peer?: string;
  samples: VideoStatsSample[];
}

export interface VideoStatsValue {
  codec?: string;
  implementation?: string;
  width?: number;
  height?: number;
  bitrate?: number;
  fps?: number;
  encodeMs?: number;
  decodeMs?: number;
  jitterMs?: number;
  encoderQueueMs?: number;
  captureToEncodeMs?: number;
  sendDelayMs?: number;
  roundTripMs?: number;
}

const number = (value: unknown): number | undefined =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0
    ? value
    : undefined;
const delta = (now?: number, before?: number) =>
  now !== undefined && before !== undefined && now >= before
    ? now - before
    : undefined;
const averageMs = (seconds?: number, frames?: number) =>
  seconds !== undefined &&
  frames !== undefined &&
  frames > 0
    ? (seconds * 1000) / frames
    : undefined;

export function videoStatsValue(
  sample: VideoStatsSample,
  previous?: VideoStatsSample,
): VideoStatsValue {
  const value: VideoStatsValue = {
    codec: sample.codec,
    implementation: sample.implementation,
    width: sample.width || undefined,
    height: sample.height || undefined,
    roundTripMs:
      number(sample.roundTripSeconds) === undefined
        ? undefined
        : sample.roundTripSeconds! * 1000,
  };
  if (
    !previous ||
    previous.id !== sample.id ||
    previous.codec !== sample.codec
  )
    return value;
  const elapsed = sample.timestamp - previous.timestamp;
  if (!(elapsed > 0)) return value;
  const frames = delta(sample.frames, previous.frames);
  const bytes = delta(sample.bytes, previous.bytes);
  // A reset starts a new interval, including the associated time counters.
  if (
    (sample.frames !== undefined &&
      previous.frames !== undefined &&
      frames === undefined) ||
    (sample.bytes !== undefined &&
      previous.bytes !== undefined &&
      bytes === undefined)
  )
    return value;
  return {
    ...value,
    bitrate:
      bytes === undefined
        ? undefined
        : (bytes * 8000) / elapsed,
    fps:
      frames === undefined
        ? undefined
        : (frames * 1000) / elapsed,
    encodeMs: averageMs(
      delta(sample.encodeSeconds, previous.encodeSeconds),
      delta(sample.encodeFrames, previous.encodeFrames),
    ),
    decodeMs: averageMs(
      delta(sample.decodeSeconds, previous.decodeSeconds),
      frames,
    ),
    jitterMs: averageMs(
      delta(sample.jitterSeconds, previous.jitterSeconds),
      delta(sample.jitterFrames, previous.jitterFrames),
    ),
    encoderQueueMs: averageMs(
      delta(
        sample.encoderQueueSeconds,
        previous.encoderQueueSeconds,
      ),
      delta(sample.encodeFrames, previous.encodeFrames),
    ),
    captureToEncodeMs: averageMs(
      delta(
        sample.captureToEncodeSeconds,
        previous.captureToEncodeSeconds,
      ),
      delta(sample.freshFrames, previous.freshFrames),
    ),
    // Packet queue delay is per packet, never divided by video frame count.
    sendDelayMs: averageMs(
      delta(
        sample.sendDelaySeconds,
        previous.sendDelaySeconds,
      ),
      delta(sample.packetsSent, previous.packetsSent),
    ),
  };
}

/** Select by the actual sender/receiver track, never by the first video report. */
export async function readBrowserVideoStats(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  direction: "send" | "receive",
): Promise<VideoStatsSample[]> {
  if (pc.connectionState === "closed") return [];
  const endpoint = (
    direction === "send"
      ? pc.getSenders()
      : pc.getReceivers()
  ).find((item) => item.track === track);
  if (!endpoint) return [];
  const report = await endpoint.getStats();
  const samples: VideoStatsSample[] = [];
  report.forEach((entry) => {
    const s = entry as RTCStats & Record<string, unknown>;
    if (
      s.type !==
        (direction === "send"
          ? "outbound-rtp"
          : "inbound-rtp") ||
      (s.kind ?? s.mediaType) !== "video" ||
      s.active === false
    )
      return;
    const codec =
      typeof s.codecId === "string"
        ? (report.get(s.codecId)?.mimeType as
            | string
            | undefined)
        : undefined;
    if (
      codec &&
      /^video\/(rtx|red|ulpfec|flexfec)/i.test(codec)
    )
      return;
    const transport =
      typeof s.transportId === "string"
        ? report.get(s.transportId)
        : undefined;
    const pair =
      typeof transport?.selectedCandidatePairId === "string"
        ? report.get(transport.selectedCandidatePairId)
        : undefined;
    samples.push({
      id: s.id,
      timestamp: s.timestamp,
      codec,
      implementation: (direction === "send"
        ? s.encoderImplementation
        : s.decoderImplementation) as string | undefined,
      width: number(s.frameWidth),
      height: number(s.frameHeight),
      bytes: number(
        direction === "send"
          ? s.bytesSent
          : s.bytesReceived,
      ),
      frames: number(
        direction === "send"
          ? s.framesEncoded
          : s.framesDecoded,
      ),
      encodeFrames: number(s.framesEncoded),
      encodeSeconds: number(s.totalEncodeTime),
      decodeSeconds: number(s.totalDecodeTime),
      jitterSeconds: number(s.jitterBufferDelay),
      jitterFrames: number(s.jitterBufferEmittedCount),
      packetsSent: number(s.packetsSent),
      sendDelaySeconds: number(s.totalPacketSendDelay),
      roundTripSeconds: number(pair?.currentRoundTripTime),
    });
  });
  return samples;
}
