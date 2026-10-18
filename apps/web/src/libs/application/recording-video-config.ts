import {
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  MP4,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import { avcUnits } from "./recording-encoded-format";

/** Let the library validate parameter sets and construct AVC/HEVC configuration.
 * Only one keyframe is probed; subsequent access units need just NAL framing.
 * Matroska requires length-prefixed NALs and CodecPrivate, unlike live Annex B. */
export async function recordingVideoConfig(
  codec: "avc" | "hevc",
  config: VideoDecoderConfig,
  first: ArrayBuffer,
): Promise<VideoDecoderConfig> {
  const target = new BufferTarget();
  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: false }),
    target,
  });
  const video = new EncodedVideoPacketSource(codec);
  output.addVideoTrack(video);
  try {
    await output.start();
    await video.add(
      new EncodedPacket(new Uint8Array(first), "key", 0, 1),
      { decoderConfig: config },
    );
    await output.finalize();
    const input = new Input({
      formats: [MP4],
      source: new BufferSource(target.buffer!),
    });
    try {
      const track = await input.getPrimaryVideoTrack();
      const normalized = await track?.getDecoderConfig();
      if (!normalized?.description?.byteLength)
        throw new Error(
          "Missing recording codec configuration",
        );
      return normalized;
    } finally {
      input.dispose();
    }
  } finally {
    if (output.state !== "finalized") await output.cancel();
  }
}

export function recordingNalUnits(
  data: ArrayBuffer,
): Uint8Array<ArrayBuffer> {
  const units = avcUnits(new Uint8Array(data));
  const result = new Uint8Array(
    units.reduce((size, unit) => size + 4 + unit.length, 0),
  );
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const unit of units) {
    view.setUint32(offset, unit.length);
    result.set(unit, offset + 4);
    offset += unit.length + 4;
  }
  return result;
}
