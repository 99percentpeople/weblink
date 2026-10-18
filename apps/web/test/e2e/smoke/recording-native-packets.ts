import {
  ALL_FORMATS,
  BufferSource,
  Input,
  EncodedPacketSink,
} from "mediabunny";
import { RecordingService } from "@/libs/application/recording-service";
import type { RecordingContainer } from "@/libs/application/recording-options";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import type {
  EncodedMediaConsumer,
  EncodedMediaSource,
  StoredFile,
} from "@weblink/platform";
import {
  h264Keyframe,
  hevcKeyframe,
} from "../../fixtures/recording-packets";

async function senderOpusPackets(): Promise<ArrayBuffer[]> {
  const packets: ArrayBuffer[] = [];
  let failure: Error | undefined;
  const encoder = new AudioEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      packets.push(bytes.buffer);
    },
    error(error) {
      failure = error;
    },
  });
  try {
    encoder.configure({
      codec: "opus",
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    });
    for (let index = 0; index < 50; index++) {
      const samples = new Float32Array(960 * 2);
      for (let sample = 0; sample < 960; sample++) {
        const value =
          0.4 *
          Math.sin(
            (2 * Math.PI * 440 * (index * 960 + sample)) /
              48000,
          );
        samples[sample * 2] = samples[sample * 2 + 1] =
          value;
      }
      const data = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfChannels: 2,
        numberOfFrames: 960,
        timestamp: index * 20000,
        data: samples,
      });
      try {
        encoder.encode(data);
      } finally {
        data.close();
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    if (packets.length < 50)
      throw new Error("Missing test sender Opus frames");
    return packets;
  } finally {
    encoder.close();
  }
}

/** Real muxing, PCM fallback and VFS publication from the native source contract. */
export async function checkNativeRecordingPackets(
  video: MediaStreamTrack,
  audio: AudioContext,
  container: RecordingContainer = "auto",
): Promise<unknown[]> {
  const results: unknown[] = [];
  const opus = await senderOpusPackets();
  for (const audioMode of [
    "pcm",
    "opus",
    "fallback",
  ] as const) {
    for (const [codec, base64] of [
      ["h264", h264Keyframe],
      ["h265", hevcKeyframe],
    ]) {
      const bytes = Uint8Array.from(atob(base64), (value) =>
        value.charCodeAt(0),
      ).buffer;
      let consumer!: EncodedMediaConsumer;
      let segment = 0,
        time = 5_000_000;
      let queue = Promise.resolve();
      let stopped = 0,
        openedFallback = 0,
        videoEncoders = 0,
        audioEncoders = 0,
        fallbackStops = 0;
      const original = window.VideoEncoder;
      const originalAudio = window.AudioEncoder;
      window.AudioEncoder = class extends originalAudio {
        constructor(init: AudioEncoderInit) {
          super(init);
          audioEncoders++;
        }
      };
      window.VideoEncoder = class extends original {
        constructor(init: VideoEncoderInit) {
          super(init);
          videoEncoders++;
        }
      };
      const frame = () =>
        consumer.frame({
          data: bytes.slice(0),
          type: "key",
          timestamp: time,
          timestampScale: 1000000,
          clockTime: time / 1000,
          mimeType: `video/${codec}`,
          width: 64,
          height: 48,
          ssrc: 0,
          spatialIndex: 0,
          segment,
        });
      const sound = (index: number) =>
        consumer.encodedAudio!({
          data: opus[index].slice(0),
          timestamp: index * 960,
          clockTime: time / 1000,
          mimeType: "audio/opus",
          ssrc: 42,
          sampleRate: 48000,
          channelCount: 2,
          segment,
        });
      const source: EncodedMediaSource = {
        async subscribe(next) {
          consumer = next;
          return {
            encodedAudio: audioMode === "opus",
            audioFormat:
              audioMode === "opus"
                ? undefined
                : {
                    sampleRate: 48000,
                    channelCount: 2,
                  },
            resume() {
              segment++;
              queue = queue.then(async () => {
                await frame();
                if (audioMode === "opus") await sound(0);
              });
            },
            pause() {},
            async stop() {
              stopped++;
              await queue;
            },
          };
        },
      };
      const storage = new FileStorageService(
        undefined,
        new VfsDatabase(
          `native-recording-${codec}-${crypto.randomUUID()}`,
        ),
      );
      let saved: StoredFile | undefined, failure: unknown;
      const service = new RecordingService({
        container: () => container,
        storage,
        changed() {},
        async complete(value) {
          saved = value.file;
        },
        failed(error) {
          failure = error;
        },
      });
      try {
        await service.start({
          id: codec,
          name: codec,
          local: true,
          video,
          audio: [],
          available: () => true,
          encodedVideoSources: () =>
            audioMode === "fallback"
              ? [
                  {
                    encodedAudio: true,
                    subscribe(consumer) {
                      return {
                        encodedAudio: true,
                        resume() {
                          consumer.ended(
                            new Error(
                              "Sender audio capture clock unavailable",
                            ),
                          );
                        },
                        pause() {},
                        async stop() {
                          fallbackStops++;
                        },
                      };
                    },
                  },
                  source,
                ]
              : [source],
          async open() {
            openedFallback++;
            throw new Error(
              "Native packets must not open a receiver",
            );
          },
        });
        await queue;
        const feed = async () => {
          for (let index = 0; index < 100; index++) {
            if (index % 3 === 0) await frame();
            const samples = new Int16Array(480 * 2);
            for (let sample = 0; sample < 480; sample++) {
              const value = Math.round(
                12000 *
                  Math.sin(
                    (2 *
                      Math.PI *
                      440 *
                      (index * 480 + sample)) /
                      48000,
                  ),
              );
              samples[sample * 2] = samples[
                sample * 2 + 1
              ] = value;
            }
            if (audioMode === "opus") {
              if (index % 2 === 0) await sound(index / 2);
            } else
              await consumer.audio!({
                data: samples.buffer,
                timestamp: time,
                segment,
                sampleRate: 48000,
                channelCount: 2,
              });
            time += 10000;
          }
        };
        await feed();
        service.pause();
        time += 10_000_000;
        service.resume();
        await queue;
        await feed();
        service.pause();
        await service.stop();
        if (failure || !saved)
          throw (
            failure ??
            new Error(
              "Native packet recording did not publish",
            )
          );
        if (openedFallback || videoEncoders)
          throw new Error(
            "Direct recording opened a video encoder or local receiver",
          );
        if (
          audioMode === "opus"
            ? audioEncoders !== 0
            : audioEncoders < 1
        )
          throw new Error(
            `Wrong native audio path: ${audioMode}, encoders=${audioEncoders}`,
          );
        if (audioMode === "fallback" && fallbackStops !== 1)
          throw new Error(
            "Encoded audio failure was not released before PCM fallback",
          );
        if (!stopped || video.readyState !== "live")
          throw new Error(
            "Native recording cleanup lost source ownership",
          );
        const data = await saved.arrayBuffer();
        if (
          container !== "auto" &&
          !saved.name.endsWith(`.${container}`)
        )
          throw new Error(
            "Native recording ignored the selected container",
          );
        const input = new Input({
          formats: ALL_FORMATS,
          source: new BufferSource(data),
        });
        try {
          const track =
            (await input.getPrimaryVideoTrack())!;
          if (
            track.codec !==
            (codec === "h265" ? "hevc" : "avc")
          )
            throw new Error("Native video was transcoded");
          const duration = await input.computeDuration();
          if (Math.abs(duration - 2) > 0.15)
            throw new Error(
              `Pause gap entered native video: ${duration}`,
            );
          const key = await new EncodedPacketSink(
            track,
          ).getKeyPacket(1.5);
          if (!key || key.timestamp < 1)
            throw new Error(
              "Native recording has no seek index after resume",
            );
          const decoded = await audio.decodeAudioData(
            data.slice(0),
          );
          const samples = decoded.getChannelData(0);
          const rms = Math.sqrt(
            samples.reduce(
              (sum, sample) => sum + sample * sample,
              0,
            ) / samples.length,
          );
          if (
            Math.abs(decoded.duration - 2) > 0.15 ||
            rms < 0.1
          )
            throw new Error(
              `Native audio was lost or desynchronized: ${decoded.duration}, ${rms}`,
            );
          results.push({
            container,
            nativePackets: codec,
            audioMode,
            audioEncoders,
            fallbackStops,
            videoCodec: track.codec,
            duration,
            audioDuration: decoded.duration,
            audioRms: rms,
            videoEncoders,
            openedFallback,
            bytes: saved.size,
          });
        } finally {
          input.dispose();
        }
      } finally {
        await service.stop();
        storage.dispose();
        window.VideoEncoder = original;
        window.AudioEncoder = originalAudio;
      }
    }
  }
  return results;
}
