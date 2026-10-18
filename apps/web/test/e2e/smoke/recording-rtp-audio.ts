import {
  ALL_FORMATS,
  BufferSource,
  EncodedPacketSink,
  Input,
} from "mediabunny";
import {
  RECORDING_AUDIO_CODECS,
  type StoredFile,
  type EncodedMediaSource,
} from "@weblink/platform";
import { RtpEncodedMediaTrack } from "@/libs/domain/rtp-encoded-media";
import { recordingMediaSources } from "@/libs/domain/recording-media-sources";
import { RecordingService } from "@/libs/application/recording-service";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(
  ready: () => boolean | Promise<boolean>,
) {
  const deadline = performance.now() + 10000;
  while (!(await ready())) {
    if (performance.now() > deadline)
      throw new Error("Audio reuse test timed out");
    await sleep(25);
  }
}

/** Real negotiated RTP, the production muxer and VFS. The viewer keeps receiving through pause/stop. */
export async function checkRtpRecordingAudio(
  input: MediaStream,
): Promise<unknown[]> {
  const camera = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 360, frameRate: 30 },
  });
  const source = new MediaStream([
    ...camera.getVideoTracks(),
    ...input.getAudioTracks(),
  ]);
  const results: unknown[] = [];
  try {
    for (const format of RECORDING_AUDIO_CODECS.filter(
      (value) => value.codec !== "opus",
    )) {
      for (const direction of [
        "send",
        "receive",
      ] as const) {
        for (const kind of [
          "indexeddb",
          "directory",
        ] as const) {
          const sender = new RTCPeerConnection(),
            receiver = new RTCPeerConnection();
          const incoming = new MediaStream();
          const taps = new Map<
            MediaStreamTrack,
            RtpEncodedMediaTrack
          >();
          const viewer = document.createElement("video");
          viewer.muted = true;
          document.body.append(viewer);
          const storage = new FileStorageService(
            undefined,
            new VfsDatabase(
              `audio-reuse-${crypto.randomUUID()}`,
            ),
          );
          const Audio = window.AudioEncoder,
            Video = window.VideoEncoder;
          let audioEncoders = 0,
            videoEncoders = 0,
            recorders = 0,
            completed = 0;
          let saved: StoredFile | undefined,
            failure: unknown;
          let service: RecordingService | undefined;
          const borrowed: Uint8Array[] = [];
          let firstSound: unknown;
          let firstVideo:
            | { clockTime?: number }
            | undefined;
          const preparationErrors: string[] = [];
          const progress = async () => {
            const stats = [
              ...(await receiver.getStats()).values(),
            ];
            return {
              video:
                stats.find(
                  (stat) =>
                    stat.type === "inbound-rtp" &&
                    stat.kind === "video",
                )?.framesDecoded ?? 0,
              audio:
                stats.find(
                  (stat) =>
                    stat.type === "inbound-rtp" &&
                    stat.kind === "audio",
                )?.totalSamplesReceived ?? 0,
            };
          };
          try {
            await storage.initialize();
            if (kind === "directory")
              await storage.setDefault(
                (await storage.mountDirectory())!,
              );
            sender.onicecandidate = ({ candidate }) => {
              if (candidate)
                void receiver.addIceCandidate(candidate);
            };
            receiver.onicecandidate = ({ candidate }) => {
              if (candidate)
                void sender.addIceCandidate(candidate);
            };
            receiver.ontrack = ({
              track,
              receiver: endpoint,
            }) => {
              incoming.addTrack(track);
              if (direction === "receive") {
                const tap = RtpEncodedMediaTrack.install(
                  endpoint,
                  receiver,
                  undefined,
                  "receive",
                );
                assert(
                  tap,
                  "Receiver transform unavailable",
                );
                taps.set(track, tap);
              }
            };
            for (const track of source.getTracks()) {
              const endpoint = sender.addTrack(
                track,
                source,
              );
              if (direction === "send") {
                const tap = RtpEncodedMediaTrack.install(
                  endpoint,
                  sender,
                );
                assert(tap, "Sender transform unavailable");
                taps.set(track, tap);
              }
            }
            for (const transceiver of sender.getTransceivers()) {
              const media = transceiver.sender.track!.kind;
              const mime =
                media === "audio"
                  ? format.mimeType
                  : "video/h264";
              const codecs = RTCRtpSender.getCapabilities(
                media,
              )!.codecs.filter(
                (codec) =>
                  codec.mimeType.toLowerCase() === mime,
              );
              assert(
                codecs.length,
                `Missing test codec ${mime}`,
              );
              transceiver.setCodecPreferences(codecs);
            }
            await sender.setLocalDescription(
              await sender.createOffer(),
            );
            await receiver.setRemoteDescription(
              sender.localDescription!,
            );
            await receiver.setLocalDescription(
              await receiver.createAnswer(),
            );
            await sender.setRemoteDescription(
              receiver.localDescription!,
            );
            await waitFor(
              () => incoming.getTracks().length === 2,
            );
            viewer.srcObject = incoming;
            await viewer.play();
            await waitFor(async () => {
              const now = await progress();
              return now.video > 5 && now.audio > 0;
            });
            window.AudioEncoder = class extends Audio {
              constructor(init: AudioEncoderInit) {
                super(init);
                audioEncoders++;
              }
            };
            window.VideoEncoder = class extends Video {
              constructor(init: VideoEncoderInit) {
                super(init);
                videoEncoders++;
              }
            };
            class Recorder extends MediaRecorder {
              constructor(
                stream: MediaStream,
                options?: MediaRecorderOptions,
              ) {
                super(stream, options);
                recorders++;
              }
            }
            const stream =
              direction === "send" ? source : incoming;
            const video = stream.getVideoTracks()[0],
              audio = stream.getAudioTracks()[0];
            const sound = taps.get(audio)!;
            const observed: EncodedMediaSource = {
              subscribe(consumer) {
                return sound.subscribe({
                  ...consumer,
                  ended(error) {
                    preparationErrors.push(String(error));
                    consumer.ended(error);
                  },
                  encodedAudio(packet) {
                    firstSound ??= {
                      ...packet,
                      data: packet.data.byteLength,
                    };
                    assert(
                      packet.mimeType.toLowerCase() ===
                        format.mimeType,
                      "Wrong negotiated audio codec",
                    );
                    assert(
                      packet.sampleRate ===
                        format.sampleRate &&
                        packet.clockRate ===
                          format.clockRate,
                      "Incorrect audio/RTP clock",
                    );
                    borrowed.push(
                      new Uint8Array(packet.data).slice(),
                    );
                    return consumer.encodedAudio?.(packet);
                  },
                });
              },
            };
            const picture: EncodedMediaSource = {
              subscribe(consumer) {
                return taps.get(video)!.subscribe({
                  ...consumer,
                  frame(packet) {
                    firstVideo ??= {
                      clockTime: packet.clockTime,
                    };
                    return consumer.frame(packet);
                  },
                });
              },
            };
            service = new RecordingService({
              storage,
              recorder: Recorder,
              changed() {},
              failed(error) {
                failure = error;
              },
              async complete(result) {
                saved = result.file;
                completed++;
              },
            });
            await service.start({
              id: "audio",
              name: format.codec,
              local: direction === "send",
              video,
              audio: [audio],
              available: () =>
                video.readyState === "live" &&
                audio.readyState === "live",
              encodedVideoSources: () =>
                recordingMediaSources(picture, [observed]),
            });
            if (failure) throw failure;
            await sleep(1000);
            await service.pause();
            const beforePause = await progress();
            await sleep(500);
            const duringPause = await progress();
            assert(
              duringPause.video > beforePause.video &&
                duringPause.audio > beforePause.audio,
              "Pausing recording interrupted the viewer",
            );
            await service.resume();
            await sleep(1000);
            await Promise.all([
              service.stop(),
              service.stop(),
            ]);
            if (failure) throw failure;
            assert(
              saved && completed === 1,
              "Recording was not saved exactly once",
            );
            // Headless Chromium may omit the sender video capture clock even on
            // camera tracks. Keep the production audio fallback in that environment;
            // receivers must reuse with their synchronized delivery clock.
            const reused =
              direction === "receive" ||
              Number.isFinite(firstVideo?.clockTime);
            assert(
              audioEncoders === (reused ? 0 : 1) &&
                !videoEncoders &&
                !recorders,
              `Unexpected fallback ${format.codec} ${direction} ${kind}: ${audioEncoders}/${videoEncoders}/${recorders}, first=${JSON.stringify(firstSound)}, errors=${JSON.stringify(preparationErrors)}`,
            );
            assert(
              saved.name.endsWith(reused ? ".mkv" : ".mp4"),
              "Audio passthrough needs MKV",
            );
            const input = new Input({
              formats: ALL_FORMATS,
              source: new BufferSource(
                await saved.arrayBuffer(),
              ),
            });
            try {
              const audioTrack =
                (await input.getPrimaryAudioTrack())!;
              assert(
                audioTrack.codec ===
                  (reused ? format.codec : "opus") &&
                  audioTrack.sampleRate ===
                    (reused ? format.sampleRate : 48000),
                "Saved audio codec changed",
              );
              let count = 0,
                cursor = 0,
                end = 0;
              for await (const packet of new EncodedPacketSink(
                audioTrack,
              ).packets()) {
                assert(
                  packet.timestamp >= end - 0.003,
                  "Audio timestamps moved backwards",
                );
                end = packet.timestamp + packet.duration;
                if (reused) {
                  while (
                    cursor < borrowed.length &&
                    !(
                      borrowed[cursor].length ===
                        packet.data.length &&
                      borrowed[cursor].every(
                        (byte, i) =>
                          byte === packet.data[i],
                      )
                    )
                  )
                    cursor++;
                  assert(
                    cursor < borrowed.length,
                    "Saved audio was not copied from the negotiated stream",
                  );
                  cursor++;
                }
                count++;
              }
              assert(
                count > 50 && end > 1.4 && end < 2.5,
                `Paused time or samples changed: ${count} packets, ${end}s`,
              );
              const seek = await new EncodedPacketSink(
                audioTrack,
              ).getPacket(1);
              assert(
                seek &&
                  seek.timestamp > 0.8 &&
                  seek.timestamp <= 1,
                "Saved audio seek index is invalid",
              );
              results.push({
                codec: format.codec,
                direction,
                storage: kind,
                packets: count,
                duration: end,
                audioEncodingReused: reused,
                audioEncoders,
                videoEncoders,
                recorders,
              });
            } finally {
              input.dispose();
            }
            const beforeStop = await progress();
            await sleep(200);
            const afterStop = await progress();
            assert(
              afterStop.audio > beforeStop.audio &&
                afterStop.video > beforeStop.video,
              "Stopping recording interrupted the viewer",
            );
            assert(
              source
                .getTracks()
                .every(
                  (track) => track.readyState === "live",
                ),
              "Recorder stopped capture",
            );
          } finally {
            await service?.stop();
            window.AudioEncoder = Audio;
            window.VideoEncoder = Video;
            taps.forEach((tap) => tap.dispose());
            viewer.pause();
            viewer.srcObject = null;
            viewer.remove();
            sender.close();
            receiver.close();
            storage.dispose();
          }
        }
      }
    }
    return results;
  } finally {
    camera.getTracks().forEach((track) => track.stop());
  }
}
