// @vitest-environment node
import { expect, it } from "vitest";
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  MkvOutputFormat,
  Output,
} from "mediabunny";
import {
  encodedRecordingFormat,
  avcUnits,
} from "@/libs/application/recording-encoded-format";
import {
  h264Keyframe,
  hevcKeyframe,
} from "../fixtures/recording-packets";
import {
  recordingNalUnits,
  recordingVideoConfig,
} from "@/libs/application/recording-video-config";
import {
  vp9Keyframe,
  vp910BitKeyframe,
  av1Keyframe,
  av110BitKeyframe,
} from "../fixtures/recording-vpx-packets";
import { recordingContainerForCodec } from "@/libs/application/recording-options";

it.each(
  [
    { mime: "h264", codec: "avc", encoded: h264Keyframe },
    { mime: "h265", codec: "hevc", encoded: hevcKeyframe },
  ].flatMap((entry) => [
    { ...entry, container: "mp4" },
    { ...entry, container: "mkv" },
  ]),
)(
  "muxes real $mime access units into $container without decoding",
  async ({ mime, codec, encoded, container }) => {
    const data = Uint8Array.from(atob(encoded), (c) =>
      c.charCodeAt(0),
    );
    const first = {
      data: data.buffer,
      mimeType: `video/${mime}`,
      type: "key" as const,
      timestamp: 0,
      width: 64,
      height: 48,
      ssrc: 0,
      spatialIndex: 0,
      segment: 1,
    };
    const format = await encodedRecordingFormat(first);
    expect(format.codec).toBe(codec);
    if (codec === "hevc")
      expect(format.config.codec).toBe("hvc1.1.6.L30.90");
    if (container === "mkv") {
      format.config = await recordingVideoConfig(
        format.codec as "avc" | "hevc",
        format.config,
        data.buffer,
      );
      format.bytes = (packet) =>
        recordingNalUnits(packet.data);
    }
    const target = new BufferTarget();
    const output = new Output({
      format:
        container === "mkv"
          ? new MkvOutputFormat()
          : new Mp4OutputFormat({ fastStart: false }),
      target,
    });
    const video = new EncodedVideoPacketSource(
      format.codec,
    );
    output.addVideoTrack(video, { frameRate: 1 });
    await output.start();
    for (const timestamp of [0, 1, 2])
      await video.add(
        new EncodedPacket(
          format.bytes(first),
          "key",
          timestamp,
          1,
        ),
        { decoderConfig: format.config },
      );
    await output.finalize();
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(target.buffer!),
    });
    try {
      const track = (await input.getPrimaryVideoTrack())!;
      expect(track.codec).toBe(codec);
      expect(await track.computeDuration()).toBeCloseTo(3);
      const config = await track.getDecoderConfig();
      expect(
        config?.description?.byteLength,
      ).toBeGreaterThan(0);
      expect(config?.codedWidth).toBe(64);
      const saved = await new EncodedPacketSink(
        track,
      ).getKeyPacket(1.5);
      expect(saved?.timestamp).toBe(1);
      // Container conversion must preserve every original encoded NAL byte.
      const nal = avcUnits(data);
      let at = 0;
      for (const unit of nal) {
        const size = new DataView(
          saved!.data.buffer,
          saved!.data.byteOffset + at,
        ).getUint32(0);
        expect(
          saved!.data.subarray(at + 4, at + 4 + size),
        ).toEqual(unit);
        at += 4 + size;
      }
      expect(at).toBe(saved!.data.length);
    } finally {
      input.dispose();
    }
  },
);

it.each([
  {
    codec: "vp9",
    encoded: vp9Keyframe,
    depth: "08",
    profile: "00",
  },
  {
    codec: "vp9",
    encoded: vp910BitKeyframe,
    depth: "10",
    profile: "02",
  },
  {
    codec: "av1",
    encoded: av1Keyframe,
    depth: "08",
    profile: "0",
  },
  {
    codec: "av1",
    encoded: av110BitKeyframe,
    depth: "10",
    profile: "0",
  },
])(
  "preserves real $codec $depth-bit packets, configuration and seeking in MKV/MP4",
  async ({ codec, encoded, depth, profile }) => {
    const data = Uint8Array.from(atob(encoded), (c) =>
      c.charCodeAt(0),
    );
    const packet = {
      data: data.buffer,
      mimeType: `video/${codec}`,
      type: "key" as const,
      timestamp: 0,
      width: 64,
      height: 64,
      ssrc: 1,
      spatialIndex: 0,
      segment: 1,
    };
    const format = await encodedRecordingFormat(packet);
    expect(format.codec).toBe(codec);
    expect(format.config.codec).toMatch(
      new RegExp(
        `^${codec === "vp9" ? "vp09" : "av01"}\\.${profile}\\.[^.]+\\.${depth}(\\.|$)`,
      ),
    );
    expect(
      recordingContainerForCodec("auto", format.codec),
    ).toBe("mkv");
    expect(
      format.compatible({ ...packet, segment: 2 }),
    ).toBe(true);
    expect(
      format.compatible({
        ...packet,
        data: data.slice(0, 4).buffer,
      }),
    ).toBe(false);
    for (const outputFormat of [
      new MkvOutputFormat(),
      new Mp4OutputFormat(),
    ]) {
      const target = new BufferTarget();
      const output = new Output({
        format: outputFormat,
        target,
      });
      const video = new EncodedVideoPacketSource(
        format.codec,
      );
      output.addVideoTrack(video, { frameRate: 1 });
      await output.start();
      for (const timestamp of [0, 1, 2])
        await video.add(
          new EncodedPacket(
            format.bytes(packet),
            "key",
            timestamp,
            1,
          ),
          { decoderConfig: format.config },
        );
      await output.finalize();
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(target.buffer!),
      });
      try {
        const track = (await input.getPrimaryVideoTrack())!;
        expect(track.codec).toBe(codec);
        expect(
          (await track.getDecoderConfig())?.codec,
        ).toBe(format.config.codec);
        expect(await track.computeDuration()).toBeCloseTo(
          3,
        );
        const saved = await new EncodedPacketSink(
          track,
        ).getKeyPacket(1.5);
        expect(saved?.timestamp).toBe(1);
        expect(saved?.data).toEqual(
          Uint8Array.from(atob(encoded), (c) =>
            c.charCodeAt(0),
          ),
        );
      } finally {
        input.dispose();
      }
    }
  },
);
