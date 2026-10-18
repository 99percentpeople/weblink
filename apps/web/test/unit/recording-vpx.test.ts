// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";
import { createEncodedRecording } from "@/libs/application/recording-encoded";
import { encodedRecordingFormat } from "@/libs/application/recording-encoded-format";
import type {
  EncodedMediaConsumer,
  EncodedVideoPacket,
  EncodedVideoSource,
} from "@/libs/domain/encoded-video";
import {
  vp9Keyframe,
  vp910BitKeyframe,
  av1Keyframe,
  av110BitKeyframe,
} from "../fixtures/recording-vpx-packets";

afterEach(() => vi.unstubAllGlobals());
const cases = [
  {
    codec: "vp9",
    encoded: vp9Keyframe,
    changed: vp910BitKeyframe,
  },
  {
    codec: "av1",
    encoded: av1Keyframe,
    changed: av110BitKeyframe,
  },
];
const packet = (
  codec: string,
  encoded: string,
): EncodedVideoPacket => ({
  mimeType: `video/${codec}`,
  data: Uint8Array.from(atob(encoded), (c) =>
    c.charCodeAt(0),
  ).buffer,
  type: "key",
  timestamp: 90000,
  width: 64,
  height: 64,
  ssrc: 1,
  spatialIndex: 0,
  segment: 1,
});

it.each(cases)(
  "rejects malformed $codec headers and detects bit-depth changes before muxing",
  async ({ codec, encoded, changed }) => {
    const first = packet(codec, encoded);
    const format = await encodedRecordingFormat(first);
    expect(format.compatible(packet(codec, changed))).toBe(
      false,
    );
    for (const data of [
      new ArrayBuffer(0),
      first.data.slice(0, 4),
      new Uint8Array([0xff, 0xff, 0xff]).buffer,
    ])
      await expect(
        encodedRecordingFormat({ ...first, data }),
      ).rejects.toThrow();
  },
);

it.each(
  cases.flatMap((entry) =>
    (["auto", "mkv", "mp4"] as const).map((container) => ({
      ...entry,
      container,
    })),
  ),
)(
  "records $codec as $container across pause/resume without any video encoder/decoder",
  async ({ codec, encoded, container }) => {
    const videoEncoder = vi.fn(() => {
      throw new Error("Unexpected encoding");
    });
    const videoDecoder = vi.fn(() => {
      throw new Error("Unexpected decoding");
    });
    vi.stubGlobal("VideoEncoder", videoEncoder);
    vi.stubGlobal("VideoDecoder", videoDecoder);
    let consumer!: EncodedMediaConsumer;
    let segment = 0,
      timestamp = 90000;
    let queue = Promise.resolve();
    const send = () => {
      const next = {
        ...packet(codec, encoded),
        segment,
        timestamp,
      };
      queue = queue.then(async () => {
        await consumer.frame(next);
      });
      return queue;
    };
    const stop = vi.fn(async () => {
      await queue;
    });
    const source: EncodedVideoSource = {
      subscribe(next) {
        consumer = next;
        return {
          pause() {},
          resume() {
            segment++;
            void send();
          },
          stop,
        };
      },
    };
    const recorder = await createEncodedRecording(
      [source],
      {
        getAudioTracks: () => [],
      } as unknown as MediaStream,
      new AbortController().signal,
      container,
    );
    expect(recorder).toBeDefined();
    const chunks: Blob[] = [],
      errors: unknown[] = [];
    recorder!.addEventListener("dataavailable", (event) =>
      chunks.push((event as BlobEvent).data),
    );
    recorder!.addEventListener("error", (event) =>
      errors.push(
        (event as Event & { error: unknown }).error,
      ),
    );
    const done = new Promise<void>((resolve) =>
      recorder!.addEventListener("stop", () => resolve(), {
        once: true,
      }),
    );
    try {
      recorder!.start();
      await queue;
      timestamp += 3000;
      await send();
      recorder!.pause();
      expect(recorder!.state).toBe("paused");
      timestamp += 900000;
      recorder!.resume();
      await queue;
      timestamp += 3000;
      await send();
      recorder!.stop();
      recorder!.stop();
      await done;
      expect(errors).toEqual([]);
      expect(stop).toHaveBeenCalledOnce();
      const bytes = new Uint8Array(
        await new Blob(chunks).arrayBuffer(),
      );
      for (const patch of recorder!.getPatches!())
        bytes.set(patch.data, patch.offset);
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(bytes),
      });
      try {
        const track = (await input.getPrimaryVideoTrack())!;
        expect(track.codec).toBe(codec);
        expect((await input.getFormat()).mimeType).toBe(
          container === "mp4"
            ? "video/mp4"
            : "video/x-matroska",
        );
        expect(await track.computeDuration()).toBeLessThan(
          0.2,
        );
        const packets = [];
        for await (const saved of new EncodedPacketSink(
          track,
        ).packets())
          packets.push(saved);
        expect(packets).toHaveLength(4);
        expect(packets.map((p) => p.timestamp)).toEqual([
          0,
          expect.closeTo(1 / 30, 2),
          expect.closeTo(2 / 30, 2),
          expect.closeTo(3 / 30, 2),
        ]);
        for (const saved of packets)
          expect(saved.data).toEqual(
            new Uint8Array(packet(codec, encoded).data),
          );
        expect(videoEncoder).not.toHaveBeenCalled();
        expect(videoDecoder).not.toHaveBeenCalled();
      } finally {
        input.dispose();
      }
    } finally {
      await recorder!.dispose!();
    }
  },
);
