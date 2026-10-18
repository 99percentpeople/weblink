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

/** Real muxing, Opus encoding and VFS publication from the native binary source contract. */
export async function checkNativeRecordingPackets(
  video: MediaStreamTrack,
  audio: AudioContext,
  container: RecordingContainer = "auto",
): Promise<unknown[]> {
  const results: unknown[] = [];
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
      videoEncoders = 0;
    const original = window.VideoEncoder;
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
        mimeType: `video/${codec}`,
        width: 64,
        height: 48,
        ssrc: 0,
        spatialIndex: 0,
        segment,
      });
    const source: EncodedMediaSource = {
      async subscribe(next) {
        consumer = next;
        return {
          audioFormat: {
            sampleRate: 48000,
            channelCount: 2,
          },
          resume() {
            segment++;
            queue = queue.then(async () => {
              await frame();
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
        encodedVideoSources: () => [source],
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
            samples[sample * 2] = samples[sample * 2 + 1] =
              value;
          }
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
        const track = (await input.getPrimaryVideoTrack())!;
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
    }
  }
  return results;
}
