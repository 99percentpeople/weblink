// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { RECORDING_AUDIO_CODECS } from "@weblink/platform";
import {
  RecordingEncodedAudio,
  recordingEncodedAudioConfig,
  recordingEncodedAudioDuration,
} from "@/libs/application/recording-encoded-audio";
import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";
import { createEncodedRecording } from "@/libs/application/recording-encoded";
import {
  recordingOpusConfig,
  recordingOpusDuration,
} from "@/libs/application/recording-opus";
import { RecordingMuxerWrites } from "@/libs/application/recording-muxer-writes";
import type {
  EncodedAudioPacket,
  EncodedMediaConsumer,
  EncodedMediaSource,
  EncodedVideoPacket,
} from "@/libs/domain/encoded-video";
import { h264Keyframe } from "../fixtures/recording-packets";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const sound = (
  segment = 1,
  clockTime = 1000,
): EncodedAudioPacket => ({
  data: new Uint8Array([0xf8, 0xff, 0xfe]).buffer,
  timestamp: 0xfffffff0,
  clockTime,
  mimeType: "audio/opus",
  sampleRate: 48000,
  channelCount: 2,
  ssrc: 2,
  segment,
});
const picture = (
  segment = 1,
  clockTime = 1000,
): EncodedVideoPacket => ({
  data: Uint8Array.from(atob(h264Keyframe), (c) =>
    c.charCodeAt(0),
  ).buffer,
  timestamp: 1234567,
  clockTime,
  segment,
  mimeType: "video/h264",
  type: "key",
  width: 64,
  height: 48,
  ssrc: 1,
  spatialIndex: 0,
});
it("reads Opus packet durations and rejects unsupported encodings and missing clocks", () => {
  expect(
    recordingOpusDuration(new Uint8Array(sound().data)),
  ).toBe(0.02);
  expect(
    recordingOpusDuration(new Uint8Array([0x80])),
  ).toBe(0.0025);
  expect(
    recordingOpusDuration(new Uint8Array([0x98 | 3, 6])),
  ).toBe(0.12);
  for (const data of [[], [0xff], [0xff, 63]])
    expect(() =>
      recordingOpusDuration(new Uint8Array(data)),
    ).toThrow();
  for (const patch of [
    { mimeType: "audio/red" },
    { clockTime: undefined },
    { sampleRate: 8000 },
  ])
    expect(() =>
      recordingOpusConfig({ ...sound(), ...patch }),
    ).toThrow();
});

it.each(
  RECORDING_AUDIO_CODECS.flatMap((format) =>
    (format.codec === "opus"
      ? (["mp4", "mkv", "auto"] as const)
      : (["mkv", "auto"] as const)
    ).map((container) => ({ ...format, container })),
  ),
)(
  "copies $codec into $container without encoding, removes pauses and drains the last packet",
  async ({
    codec,
    mimeType,
    sampleRate,
    clockRate,
    channels,
    container,
  }) => {
    const sound = (
      segment = 1,
      clockTime = 1000,
    ): EncodedAudioPacket => ({
      data:
        codec === "opus"
          ? new Uint8Array([0xf8, 0xff, 0xfe]).buffer
          : new Uint8Array(160).fill(0x55).buffer,
      mimeType,
      sampleRate,
      clockRate,
      channelCount: channels,
      timestamp: 0xfffffff0,
      clockTime,
      segment,
      ssrc: 2,
    });
    const encoder = vi.fn(() => {
      throw new Error("Unexpected audio encoding");
    });
    vi.stubGlobal("AudioEncoder", encoder);
    vi.stubGlobal("MediaStreamTrackProcessor", undefined);
    let consumer!: EncodedMediaConsumer;
    let segment = 0,
      clockTime = 1000;
    let queue = Promise.resolve();
    const send = () => {
      const video = picture(segment, clockTime),
        audio = sound(segment, clockTime + 10);
      queue = queue.then(async () => {
        // Audio can arrive before the resumed video keyframe.
        await consumer.encodedAudio!(audio);
        await consumer.frame(video);
      });
      return queue;
    };
    const stop = vi.fn(async () => {
      await queue;
    });
    const resume = vi.fn(() => {
      segment++;
      void send();
    });
    const source: EncodedMediaSource = {
      encodedAudio: true,
      subscribe(value) {
        consumer = value;
        return {
          encodedAudio: true,
          pause() {},
          resume,
          stop,
        };
      },
    };
    const engine = await createEncodedRecording(
      [source],
      { getAudioTracks: () => [{}] } as MediaStream,
      new AbortController().signal,
      container,
    );
    expect(engine).toBeDefined();
    const chunks: Blob[] = [],
      errors: unknown[] = [];
    engine!.addEventListener("dataavailable", (e) =>
      chunks.push((e as BlobEvent).data),
    );
    engine!.addEventListener("error", (e) =>
      errors.push(e),
    );
    const done = new Promise<void>((resolve) =>
      engine!.addEventListener("stop", () => resolve(), {
        once: true,
      }),
    );
    try {
      engine!.start();
      await queue;
      expect(resume).toHaveBeenCalledOnce(); // Preparation's keyframe becomes the start, without another PLI.
      engine!.pause();
      clockTime += 10000;
      engine!.resume();
      await queue;
      // A final audio packet must survive stop, even when no more video arrives.
      await consumer.encodedAudio!({
        ...sound(segment, clockTime + 30),
        timestamp: 944,
      });
      engine!.stop();
      engine!.stop();
      await done;
      expect(errors).toEqual([]);
      const bytes = new Uint8Array(
        await new Blob(chunks).arrayBuffer(),
      );
      for (const patch of engine!.getPatches!())
        bytes.set(patch.data, patch.offset);
      if (process.env.RECORDING_TEST_ARTIFACTS) {
        const { mkdir, writeFile } =
          await import("node:fs/promises");
        const path = process.env.RECORDING_TEST_ARTIFACTS;
        await mkdir(path, { recursive: true });
        await writeFile(
          `${path}/${codec}-${container}.${engine!.mimeType.includes("mp4") ? "mp4" : "mkv"}`,
          bytes,
        );
      }
      const input = new Input({
        formats: ALL_FORMATS,
        source: new BufferSource(bytes),
      });
      try {
        const audio = (await input.getPrimaryAudioTrack())!;
        expect(audio.codec).toBe(codec);
        expect(audio.sampleRate).toBe(sampleRate);
        expect(audio.numberOfChannels).toBe(channels);
        expect(engine!.mimeType).toContain(codec);
        if (codec !== "opus")
          expect(engine!.mimeType).toContain("matroska");
        const packets = [];
        for await (const packet of new EncodedPacketSink(
          audio,
        ).packets())
          packets.push(packet);
        expect(packets).toHaveLength(3);
        for (const packet of packets)
          expect(packet.data).toEqual(
            new Uint8Array(sound().data),
          );
        expect(packets[0].timestamp).toBeCloseTo(0.01, 2);
        expect(packets[2].timestamp).toBeLessThan(0.1);
        expect(await audio.computeDuration()).toBeLessThan(
          0.12,
        );
        expect(encoder).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledOnce();
      } finally {
        input.dispose();
      }
    } finally {
      await engine!.dispose!();
    }
  },
);

it.each(["clock", "video-clock", "codec", "silent"])(
  "releases both encoded tracks for fallback when audio is %s",
  async (failure) => {
    vi.useFakeTimers();
    const stop = vi.fn(async () => {});
    const source: EncodedMediaSource = {
      encodedAudio: true,
      subscribe(consumer) {
        return {
          encodedAudio: true,
          pause() {},
          stop,
          resume() {
            queueMicrotask(() => {
              void consumer.frame({
                ...picture(),
                ...(failure === "video-clock"
                  ? { clockTime: undefined }
                  : {}),
              });
              if (failure !== "silent")
                void consumer.encodedAudio!({
                  ...sound(),
                  ...(failure === "video-clock"
                    ? {}
                    : failure === "clock"
                      ? { clockTime: undefined }
                      : { mimeType: "audio/red" }),
                });
            });
          },
        };
      },
    };
    const result = createEncodedRecording(
      [source],
      {
        getAudioTracks: () => [],
      } as unknown as MediaStream,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(2501);
    expect(await result).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
  },
);

it.each(RECORDING_AUDIO_CODECS)(
  "validates $codec metadata and duration",
  (format) => {
    const packet = {
      ...sound(),
      mimeType: format.mimeType,
      sampleRate: format.sampleRate,
      clockRate: format.clockRate,
      channelCount: format.channels,
      data:
        format.codec === "opus"
          ? sound().data
          : new Uint8Array(160).buffer,
    };
    expect(recordingEncodedAudioConfig(packet).codec).toBe(
      format.codec,
    );
    expect(recordingEncodedAudioDuration(packet)).toBe(
      0.02,
    );
    for (const invalid of [
      { clockRate: 90000 },
      { sampleRate: 44100 },
      { channelCount: 6 },
      { clockTime: undefined },
      { data: new ArrayBuffer(0) },
    ])
      expect(() =>
        recordingEncodedAudioConfig({
          ...packet,
          ...invalid,
        }),
      ).toThrow();
  },
);
it.each(
  RECORDING_AUDIO_CODECS.filter(
    (format) => format.codec !== "opus",
  ),
)(
  "releases $codec for the existing fallback when MP4 is explicitly selected",
  async (format) => {
    const stop = vi.fn(async () => {});
    const source: EncodedMediaSource = {
      encodedAudio: true,
      subscribe(consumer) {
        return {
          encodedAudio: true,
          pause() {},
          stop,
          resume() {
            queueMicrotask(() => {
              void consumer.frame(picture());
              void consumer.encodedAudio!({
                ...sound(),
                ...format,
                data: new Uint8Array(160).buffer,
                channelCount: format.channels,
              });
            });
          },
        };
      },
    };
    const fallback: EncodedMediaSource = {
      subscribe: vi.fn(() => null),
    };
    expect(
      await createEncodedRecording(
        [source, fallback],
        {
          getAudioTracks: () => [],
        } as unknown as MediaStream,
        new AbortController().signal,
        "mp4",
      ),
    ).toBeUndefined();
    expect(stop).toHaveBeenCalledOnce();
    expect(fallback.subscribe).toHaveBeenCalledOnce();
  },
);

it("rejects codec changes in an existing track and bounds audio waiting for a video keyframe", async () => {
  const first = {
    ...sound(),
    mimeType: "audio/g722",
    sampleRate: 16000,
    clockRate: 8000,
    channelCount: 1,
    data: new Uint8Array(160).buffer,
  };
  const audio = new RecordingEncodedAudio(
    first,
    new RecordingMuxerWrites(),
  );
  expect(() =>
    audio.add({
      ...first,
      mimeType: "audio/pcmu",
      sampleRate: 8000,
    }),
  ).toThrow("format changed");
  expect(() => audio.add({ ...first, ssrc: 5 })).toThrow(
    "format changed",
  );
  for (let index = 0; index < 256; index++)
    await audio.add(first);
  expect(() => audio.add(first)).toThrow(
    "waiting too long",
  );
});

it("waits for a receiver delivery clock during preparation without losing the first synchronized packet", async () => {
  const packet = {
    ...sound(),
    mimeType: "audio/g722",
    sampleRate: 16000,
    clockRate: 8000,
    channelCount: 1,
    data: new Uint8Array(160).buffer,
  };
  let consumer!: EncodedMediaConsumer;
  const stop = vi.fn(async () => {});
  const source: EncodedMediaSource = {
    encodedAudio: true,
    subscribe(value) {
      consumer = value;
      return {
        encodedAudio: true,
        stop,
        pause() {},
        resume() {
          queueMicrotask(() => {
            void consumer.frame(picture());
            void consumer.encodedAudio!({
              ...packet,
              clockTime: undefined,
            });
          });
        },
      };
    },
  };
  const prepared = createEncodedRecording(
    [source],
    { getAudioTracks: () => [] } as unknown as MediaStream,
    new AbortController().signal,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stop).not.toHaveBeenCalled();
  await consumer.encodedAudio!(packet);
  const engine = await prepared;
  expect(engine?.mimeType).toContain("g722");
  await engine!.dispose!();
  expect(stop).toHaveBeenCalledOnce();
});
