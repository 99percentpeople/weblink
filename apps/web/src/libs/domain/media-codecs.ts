import {
  AUDIO_CODECS,
  VIDEO_CODECS,
  type MediaDecodeCapabilities,
} from "./protocol/media-codecs";

export type MediaKind = "video" | "audio";
const baseline: MediaDecodeCapabilities = {
  video: ["video/h264", "video/vp8"],
  audio: ["audio/opus", "audio/pcmu", "audio/pcma"],
};

export function browserCodecs(
  direction: "send" | "receive",
  kind: MediaKind,
): string[] | null {
  try {
    const rtp =
      direction === "send" ? RTCRtpSender : RTCRtpReceiver;
    const capabilities = rtp.getCapabilities(kind);
    return capabilities
      ? [
          ...new Set(
            capabilities.codecs.map((codec) =>
              codec.mimeType.toLowerCase(),
            ),
          ),
        ].filter((codec) =>
          (kind === "video"
            ? VIDEO_CODECS
            : AUDIO_CODECS
          ).some((item) => item === codec),
        )
      : null;
  } catch {
    return null;
  }
}

export function browserDecodeCapabilities(): MediaDecodeCapabilities {
  return {
    video: browserCodecs("receive", "video"),
    audio: browserCodecs("receive", "audio"),
  };
}

/** Shared format preference, not a benchmark. Native hardware availability wins
 * before compression efficiency; unknown/legacy receivers use WebRTC baselines. */
export function commonCodecs(
  kind: MediaKind,
  encoders: readonly string[] | null,
  receivers: readonly (
    | MediaDecodeCapabilities
    | undefined
  )[],
  hardware: readonly string[] = [],
): string[] {
  const order =
    kind === "video" ? VIDEO_CODECS : AUDIO_CODECS;
  const local = encoders ?? baseline[kind]!;
  const peers = receivers.length ? receivers : [undefined];
  return order
    .filter(
      (codec) =>
        local.includes(codec) &&
        peers.every((peer) =>
          (peer?.[kind] ?? baseline[kind]!).includes(codec),
        ),
    )
    .sort(
      (a, b) =>
        Number(hardware.includes(b)) -
        Number(hardware.includes(a)),
    );
}
