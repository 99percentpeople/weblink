import type { EncodedVideoPacket } from "@/libs/domain/encoded-video";
import { recordingVpxFormat } from "./recording-vpx";

/** H.264 and H.265 native/WebRTC access units use Annex B. */
export function avcUnits(data: Uint8Array): Uint8Array[] {
  const starts: { at: number; data: number }[] = [];
  for (let at = 0; at + 3 <= data.length; at++) {
    if (data[at] || data[at + 1]) continue;
    const width =
      data[at + 2] === 1
        ? 3
        : data[at + 2] === 0 && data[at + 3] === 1
          ? 4
          : 0;
    if (!width) continue;
    starts.push({ at, data: at + width });
    at += width - 1;
  }
  if (!starts.length || starts[0].at !== 0)
    throw new Error("Unsupported Annex B packet format");
  return starts
    .map((start, index) => {
      let end = starts[index + 1]?.at ?? data.length;
      while (end > start.data && data[end - 1] === 0) end--;
      return data.subarray(start.data, end);
    })
    .filter((unit) => unit.length > 0);
}

/** Only describe the bitstream. The muxer owns AVC/HEVC configuration records and Annex B conversion. */
export async function encodedRecordingFormat(
  first: EncodedVideoPacket,
) {
  if (
    first.type !== "key" ||
    first.width <= 0 ||
    first.height <= 0 ||
    first.spatialIndex !== 0
  )
    throw new Error(
      "Encoded recording requires a complete video keyframe",
    );
  const mime = first.mimeType.toLowerCase();
  const codec = (
    {
      "video/vp8": "vp8",
      "video/vp9": "vp9",
      "video/av1": "av1",
      "video/h264": "avc",
      "video/h265": "hevc",
    } as const
  )[
    mime as
      | "video/vp8"
      | "video/vp9"
      | "video/av1"
      | "video/h264"
      | "video/h265"
  ];
  if (!codec)
    throw new Error(
      `Encoded recording does not support ${first.mimeType}`,
    );
  const annexB = codec === "avc" || codec === "hevc";
  const vpx =
    codec === "vp9" || codec === "av1"
      ? await recordingVpxFormat(codec, first)
      : undefined;
  const parameterType = (unit: Uint8Array) =>
    codec === "hevc" ? (unit[0] >> 1) & 63 : unit[0] & 31;
  const wanted = codec === "hevc" ? [32, 33, 34] : [7, 8];
  const parameters = (data: ArrayBuffer) =>
    avcUnits(new Uint8Array(data)).filter((unit) =>
      wanted.includes(parameterType(unit)),
    );
  const parameterSets = annexB
    ? parameters(first.data)
    : [];
  let codecString: string = "vp8";
  if (annexB) {
    if (
      wanted.some(
        (type) =>
          !parameterSets.some(
            (unit) => parameterType(unit) === type,
          ),
      )
    )
      throw new Error(
        "Recording keyframe is missing codec parameter sets",
      );
    const sps = parameterSets.find(
      (unit) =>
        parameterType(unit) === (codec === "hevc" ? 33 : 7),
    )!;
    if (codec === "avc") {
      if (sps.length < 4)
        throw new Error("Invalid AVC sequence parameters");
      codecString = `avc1.${Array.from(sps.subarray(1, 4), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
    } else {
      // HEVC profile_tier_level is at a fixed position before sub-layer/SPS data.
      const rbsp = sps
        .subarray(2)
        .filter(
          (value, index, bytes) =>
            !(
              value === 3 &&
              index >= 2 &&
              bytes[index - 1] === 0 &&
              bytes[index - 2] === 0
            ),
        );
      if (rbsp.length < 13)
        throw new Error("Invalid HEVC sequence parameters");
      const profile = rbsp[1];
      let compatibility = 0;
      // Reverse the 32 compatibility bits (each byte is stored most significant first).
      for (let bit = 0; bit < 32; bit++)
        if (rbsp[2 + (bit >> 3)] & (128 >> (bit % 8)))
          compatibility = (compatibility + 2 ** bit) >>> 0;
      const constraints = Array.from(rbsp.subarray(6, 12));
      while (constraints.at(-1) === 0) constraints.pop();
      codecString = `hvc1.${["", "A", "B", "C"][profile >> 6]}${profile & 31}.${compatibility.toString(16)}.${profile & 32 ? "H" : "L"}${rbsp[12]}${constraints.map((value) => `.${value.toString(16)}`).join("")}`;
    }
  }
  const config: VideoDecoderConfig = vpx?.config ?? {
    codec: codecString,
    codedWidth: first.width,
    codedHeight: first.height,
  };
  return {
    codec,
    config,
    type: annexB ? "video/mp4" : "video/x-matroska",
    compatible(packet: EncodedVideoPacket) {
      if (
        packet.mimeType.toLowerCase() !== mime ||
        packet.width !== first.width ||
        packet.height !== first.height ||
        packet.ssrc !== first.ssrc ||
        packet.spatialIndex !== 0 ||
        packet.timestampScale !== first.timestampScale
      )
        return false;
      if (vpx) return vpx.compatible(packet);
      return (
        !annexB ||
        packet.type !== "key" ||
        parameters(packet.data).every((unit) =>
          parameterSets.some(
            (old) =>
              old.length === unit.length &&
              old.every(
                (byte, index) => byte === unit[index],
              ),
          ),
        )
      );
    },
    bytes(packet: EncodedVideoPacket) {
      return new Uint8Array(packet.data);
    },
  };
}

/** Video RTP clocks are 90 kHz, wrap at 32 bits, and continue during pauses. */
export class RecordingRtpTimeline {
  private segment = -1;
  private lastRtp = 0;
  private time = 0;
  private step = 1 / 30;
  private segmentOrigin = 0;
  private segmentTime = 0;
  next(
    packet: EncodedVideoPacket,
    audioEnd?: number,
  ): number {
    if (this.segment !== packet.segment) {
      if (packet.type !== "key")
        throw new Error(
          "Recording resume requires a keyframe",
        );
      if (this.segment !== -1) {
        this.time = Math.max(
          this.time + this.step,
          audioEnd ?? 0,
        );
      }
      this.segment = packet.segment;
      this.segmentOrigin = packet.timestamp;
      this.segmentTime = this.time;
    } else {
      const native = packet.timestampScale === 1000000;
      const ticks = native
        ? packet.timestamp - this.lastRtp
        : (packet.timestamp - this.lastRtp) >>> 0;
      // Long unchanged screens are valid; only a backwards/ambiguous clock jump
      // is rejected. A 32-bit RTP clock wraps about every 13 hours.
      if (ticks < 0 || (!native && ticks >= 0x80000000))
        throw new Error(
          "Recording RTP timestamp discontinuity",
        );
      const delta =
        ticks / (packet.timestampScale ?? 90000);
      this.time += delta;
      if (delta > 0 && delta < 1) this.step = delta;
    }
    this.lastRtp = packet.timestamp;
    return this.time;
  }
  audio(
    timestamp: number,
    segment: number,
  ): number | undefined {
    if (segment !== this.segment) return;
    return (
      this.segmentTime +
      (timestamp - this.segmentOrigin) / 1_000_000
    );
  }
}
