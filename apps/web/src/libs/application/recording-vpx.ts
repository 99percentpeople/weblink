import {
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  MATROSKA,
  MkvOutputFormat,
  Output,
} from "mediabunny";
import type { EncodedVideoPacket } from "@/libs/domain/encoded-video";

/** Validate the keyframe before asking the demuxer for its actual profile/color metadata. */
function configuration(
  codec: "vp9" | "av1",
  packet: EncodedVideoPacket,
): string {
  const data = new Uint8Array(packet.data);
  const invalid = () =>
    new Error(`Invalid ${codec} recording keyframe`);
  if (codec === "vp9") {
    let bit = 0;
    const read = (count: number) => {
      if (bit + count > data.length * 8) throw invalid();
      let value = 0;
      for (let i = 0; i < count; i++, bit++)
        value =
          value * 2 +
          ((data[bit >> 3] >> (7 - (bit & 7))) & 1);
      return value;
    };
    if (read(2) !== 2) throw invalid();
    const profile = read(1) + 2 * read(1);
    if (profile === 3 && read(1)) throw invalid();
    if (read(1) || read(1)) throw invalid(); // Existing/inter frame is not a keyframe.
    read(2); // show_frame, error_resilient_mode
    if (read(24) !== 0x498342) throw invalid();
    const depth = profile >= 2 ? (read(1) ? 12 : 10) : 8;
    const color = read(3);
    let range = 1,
      x = 0,
      y = 0;
    if (color !== 7) {
      range = read(1);
      x = y = 1;
      if (profile === 1 || profile === 3) {
        x = read(1);
        y = read(1);
        if (read(1)) throw invalid();
      }
    } else if (profile === 1 || profile === 3) {
      if (read(1)) throw invalid();
    } else throw invalid();
    const width = read(16) + 1,
      height = read(16) + 1;
    if (width !== packet.width || height !== packet.height)
      throw invalid();
    return [
      profile,
      depth,
      color,
      range,
      x,
      y,
      width,
      height,
    ].join(":");
  }

  // AV1 WebRTC frames contain low-overhead OBUs. Validate lengths and reject
  // spatially layered frames; the original access unit is never modified.
  let sequence: Uint8Array | undefined;
  let frame = false,
    header = false,
    tiles = false;
  for (let at = 0; at < data.length; ) {
    const obu = data[at++];
    if (obu & 0x81) throw invalid(); // forbidden/reserved bits
    const type = (obu >> 3) & 15;
    if (obu & 4) {
      if (at === data.length) throw invalid();
      const extension = data[at++];
      if (extension & 31) throw invalid(); // spatial_id and reserved bits
    }
    let size = data.length - at;
    if (obu & 2) {
      size = 0;
      for (let i = 0; ; i++) {
        if (i === 8 || at === data.length) throw invalid();
        const byte = data[at++];
        size += (byte & 127) * 2 ** (7 * i);
        if (!(byte & 128)) break;
      }
    }
    if (size > 0xffffffff || at + size > data.length)
      throw invalid();
    if (type === 1) {
      if (!size || sequence) throw invalid();
      sequence = data.subarray(at, at + size);
    }
    frame ||= type === 6 && size > 0;
    header ||= type === 3 && size > 0;
    tiles ||= type === 4 && size > 0;
    at += size;
  }
  if (!sequence || !(frame || (header && tiles)))
    throw invalid();
  return Array.from(sequence, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** One bounded keyframe round trip uses the library's bitstream parsers, not a decoder.
 * The provisional codec string exists only in this private probe. The demuxer
 * derives profile, depth and color from the actual first packet for both codecs. */
export async function recordingVpxFormat(
  codec: "vp9" | "av1",
  first: EncodedVideoPacket,
) {
  const signature = configuration(codec, first);
  const target = new BufferTarget();
  const output = new Output({
    format: new MkvOutputFormat(),
    target,
  });
  const video = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(video);
  let config: VideoDecoderConfig;
  try {
    await output.start();
    await video.add(
      new EncodedPacket(
        new Uint8Array(first.data),
        "key",
        0,
        1,
      ),
      {
        decoderConfig: {
          codec:
            codec === "vp9"
              ? "vp09.00.10.08"
              : "av01.0.00M.08",
          codedWidth: first.width,
          codedHeight: first.height,
        },
      },
    );
    await output.finalize();
    const input = new Input({
      formats: [MATROSKA],
      source: new BufferSource(target.buffer!),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      const actual = await track?.getDecoderConfig();
      if (!actual)
        throw new Error(
          "Missing recording codec configuration",
        );
      // WebCodecs VP9/AV1 descriptions are unused. The output muxer generates
      // CodecPrivate from the now-correct codec string.
      const { description: _, ...rest } = actual;
      config = rest;
    } finally {
      input.dispose();
    }
  } finally {
    if (output.state !== "finalized") await output.cancel();
  }
  return {
    config,
    compatible(packet: EncodedVideoPacket) {
      if (packet.type !== "key") return true;
      try {
        return configuration(codec, packet) === signature;
      } catch {
        return false;
      }
    },
  };
}
