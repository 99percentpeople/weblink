import { checkNativeRecordingPackets } from "./recording-native-packets";
import { checkRtpRecordingAudio } from "./recording-rtp-audio";
import { checkRecordingAudioSync } from "./recording-audio-sync";
import {
  RecordingService,
  type RecordingState,
} from "@/libs/application/recording-service";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import type { StoredFile } from "@weblink/platform";
import {
  recordingFormat,
  resolveRecordingContainer,
} from "@/libs/application/recording-options";
import { videoThumbnail } from "@/libs/utils/video-thumbnail";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";
import {
  element,
  unsigned,
} from "@/libs/application/recording-ebml";
import { recordingMediaSources } from "@/libs/domain/recording-media-sources";
import { RtpEncodedMediaTrack } from "@/libs/domain/rtp-encoded-media";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
const container = resolveRecordingContainer(
  new URL(location.href).searchParams.get("container"),
);
async function waitFor(
  ready: () => boolean | Promise<boolean>,
  timeout = 10000,
) {
  const until = performance.now() + timeout;
  while (!(await ready())) {
    if (performance.now() > until)
      throw new Error("Recording check timed out");
    await sleep(20);
  }
}

async function seekFrame(
  player: HTMLVideoElement,
  target: number,
): Promise<number> {
  return new Promise((resolve, reject) => {
    let ended = false;
    let frameTime: number | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      player.cancelVideoFrameCallback(callback);
      player.removeEventListener("seeked", seeked);
    };
    const complete = () => {
      if (!ended || frameTime === undefined) return;
      cleanup();
      resolve(frameTime);
    };
    const seeked = () => {
      ended = true;
      complete();
    };
    const callback = player.requestVideoFrameCallback(
      (_, frame) => {
        frameTime = frame.mediaTime;
        complete();
      },
    );
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Recording seek/decode timed out: target=${target}, current=${player.currentTime}`,
        ),
      );
    }, 10000);
    player.addEventListener("seeked", seeked);
    player.currentTime = target;
  });
}

function countSeekPoints(content: ArrayBuffer): number {
  const bytes = new Uint8Array(content);
  const header = element(bytes, 0)!;
  const segment = element(bytes, header.end)!;
  const seekHead = element(bytes, segment.dataAt)!;
  assert(
    seekHead.id === 0x114d9b74,
    `Saved WebM is missing SeekHead: ${JSON.stringify(Array.from(bytes.subarray(0, 320)))}`,
  );
  for (let at = seekHead.dataAt; at < seekHead.end; ) {
    const seek = element(bytes, at)!;
    const id = element(bytes, seek.dataAt)!;
    const position = element(bytes, id.end)!;
    const target = element(
      bytes,
      segment.dataAt +
        unsigned(
          bytes.subarray(position.dataAt, position.end),
        ),
    )!;
    assert(
      target.id ===
        unsigned(bytes.subarray(id.dataAt, id.end)),
      "Invalid WebM seek offset",
    );
    if (target.id === 0x1c53bb6b) {
      assert(
        target.end === bytes.length,
        "Saved WebM is missing its final Cues data",
      );
      let count = 0;
      for (
        let cue = target.dataAt;
        cue < target.end;
        cue = element(bytes, cue)!.end
      )
        count++;
      return count;
    }
    at = seek.end;
  }
  throw new Error("Saved WebM is missing Cues");
}
async function run() {
  const passed: string[] = [];
  const measurements: unknown[] = [];
  const duration = Math.min(
    600000,
    Math.max(
      3400,
      Number(
        new URL(location.href).searchParams.get("duration"),
      ) || 3400,
    ),
  );
  const heapSize = () =>
    (
      performance as Performance & {
        memory?: { usedJSHeapSize: number };
      }
    ).memory?.usedJSHeapSize;
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  let pulse: GainNode | undefined;
  const timer = setInterval(() => {
    context.fillStyle = `hsl(${frame++ % 360} 70% 40%)`;
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "white";
    context.fillText(String(frame), 40, 40);
    if (pulse) {
      const on = audio.currentTime % 1 < 0.25;
      pulse.gain.setValueAtTime(
        on ? 1 : 0.005,
        audio.currentTime,
      );
      context.fillStyle = on ? "white" : "black";
      context.fillRect(0, 0, 32, 32);
    }
  }, 33);
  const source = canvas.captureStream(30);
  const audio = new AudioContext();
  await audio.resume();
  const destination = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  pulse = audio.createGain();
  oscillator.connect(pulse).connect(destination);
  oscillator.start();
  source.addTrack(destination.stream.getAudioTracks()[0]);
  const root = await navigator.storage.getDirectory();
  const handle = await root.getDirectoryHandle(
    `recording-${crypto.randomUUID()}`,
    { create: true },
  );
  const directoryFiles = Math.min(
    2000,
    Math.max(
      0,
      Number(
        new URL(location.href).searchParams.get(
          "directoryFiles",
        ),
      ) || 0,
    ),
  );
  for (let index = 0; index < directoryFiles; index++)
    await handle.getFileHandle(`existing-${index}.txt`, {
      create: true,
    });
  await handle.getFileHandle(".hidden", { create: true });
  await handle.getFileHandle("browser-transaction.crswap", {
    create: true,
  });
  const hidden = await handle.getDirectoryHandle(
    ".hidden-folder",
    { create: true },
  );
  await hidden.getFileHandle(
    "hidden-recording.recording.part",
    { create: true },
  );
  const picker = window.showDirectoryPicker;
  const query = FileSystemHandle.prototype.queryPermission;
  const request =
    FileSystemHandle.prototype.requestPermission;
  FileSystemHandle.prototype.queryPermission = async () =>
    "granted";
  FileSystemHandle.prototype.requestPermission = async () =>
    "granted";
  window.showDirectoryPicker = async () => handle;
  try {
    if (
      new URL(location.href).searchParams.has(
        "audioCodecsOnly",
      )
    ) {
      window.__SPEED_TEST_REPORT__ = {
        ok: true,
        measurements: await checkRtpRecordingAudio(source),
      };
      return;
    }
    for (const kind of [
      "indexeddb",
      "directory",
    ] as const) {
      const codecs =
        RTCRtpSender.getCapabilities("video")!.codecs;
      const supported = [
        "video/VP8",
        "video/H264",
        "video/VP9",
        "video/AV1",
      ].filter((mime) =>
        codecs.some((codec) => codec.mimeType === mime),
      );
      const sources = [
        undefined,
        "camera",
        ...supported,
        ...supported.map((mime) => `sender/${mime}`),
      ].filter(
        (source) =>
          !new URL(location.href).searchParams.has(
            "encodedOnly",
          ) || source?.startsWith("sender/"),
      );
      for (const codec of new URL(
        location.href,
      ).searchParams.has("nativePacketsOnly")
        ? []
        : sources) {
        const onlySource = new URL(
          location.href,
        ).searchParams.get("source");
        if (onlySource && codec !== onlySource) continue;
        const reuse = codec?.startsWith("sender/") ?? false;
        const camera = codec === "camera" || reuse;
        const negotiatedCodec = reuse
          ? codec!.slice(7)
          : codec;
        const remote = !!codec && !camera;
        const storage = new FileStorageService(
          undefined,
          new VfsDatabase(
            `recording-${crypto.randomUUID()}`,
          ),
        );
        const sender = new RTCPeerConnection();
        const receiver = new RTCPeerConnection();
        const incoming = new MediaStream();
        let service: RecordingService | undefined;
        let capture: MediaStream | undefined;
        let encoded: RtpEncodedMediaTrack | undefined;
        const taps = new Map<
          MediaStreamTrack,
          RtpEncodedMediaTrack
        >();
        const AudioEncoderConstructor = window.AudioEncoder;
        let audioEncoders = 0;
        const VideoEncoderConstructor = window.VideoEncoder;
        let webCodecsEncoders = 0;
        const viewer = document.createElement("video");
        viewer.muted = true;
        document.body.append(viewer);
        try {
          if (camera)
            capture =
              await navigator.mediaDevices.getUserMedia({
                video: {
                  width: { exact: 640 },
                  height: { exact: 360 },
                  frameRate: { ideal: 30, max: 30 },
                },
              });
          const local = capture
            ? new MediaStream([
                ...capture.getVideoTracks(),
                ...source.getAudioTracks(),
              ])
            : source;
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
            if (remote) {
              const tap = RtpEncodedMediaTrack.install(
                endpoint,
                receiver,
                undefined,
                "receive",
              );
              if (tap) taps.set(track, tap);
            }
            incoming.addTrack(track);
          };
          if (remote || camera) {
            local.getTracks().forEach((track) => {
              const outgoing = sender.addTrack(
                track,
                local,
              );
              if (reuse) {
                const tap = RtpEncodedMediaTrack.install(
                  outgoing,
                  sender,
                );
                if (tap) taps.set(track, tap);
                if (track.kind === "video") encoded = tap;
              }
            });
            if (remote || reuse)
              sender
                .getTransceivers()
                .find(
                  (transceiver) =>
                    transceiver.sender.track?.kind ===
                    "video",
                )!
                .setCodecPreferences(
                  codecs.filter(
                    (entry) =>
                      entry.mimeType === negotiatedCodec,
                  ),
                );
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
              () =>
                receiver.connectionState === "connected" &&
                incoming.getTracks().length === 2,
            );
          }
          const stream = remote ? incoming : local;
          if (reuse || remote) {
            assert(
              taps.get(stream.getVideoTracks()[0]),
              "Sender encoded transform unavailable",
            );
            viewer.srcObject = incoming;
            await viewer.play();
          }
          const decodedFrames = async () =>
            [...(await receiver.getStats()).values()].find(
              (stat) =>
                stat.type === "inbound-rtp" &&
                stat.kind === "video",
            )?.framesDecoded ?? 0;
          if (reuse || remote)
            await waitFor(
              async () => (await decodedFrames()) > 5,
            );
          let saved: StoredFile | undefined;
          let outputs = 0;
          let completions = 0;
          let error: unknown;
          let state: RecordingState | null = null;
          let encoders = 0;
          if (
            (reuse || remote) &&
            VideoEncoderConstructor
          ) {
            window.VideoEncoder = class extends (
              VideoEncoderConstructor
            ) {
              constructor(init: VideoEncoderInit) {
                super(init);
                webCodecsEncoders++;
              }
            };
          }
          if (
            (reuse || remote) &&
            AudioEncoderConstructor
          ) {
            window.AudioEncoder = class extends (
              AudioEncoderConstructor
            ) {
              constructor(init: AudioEncoderInit) {
                super(init);
                audioEncoders++;
              }
            };
          }
          class Recorder extends MediaRecorder {
            constructor(
              stream: MediaStream,
              options?: MediaRecorderOptions,
            ) {
              super(stream, options);
              encoders++;
            }
          }
          service = new RecordingService({
            container: () => container,
            recorder: Recorder,
            storage: {
              authorizeDefault: (options) =>
                storage.authorizeDefault(options),
              createWritableFile: (options) => {
                outputs++;
                return storage.createWritableFile(options);
              },
            },
            changed: (value) => {
              state = value;
            },
            failed: (cause) => {
              error = cause;
            },
            complete: async ({ file }) => {
              completions++;
              saved = file;
            },
          });
          // Reproduce the previous two blocking authorization scans for an
          // optional populated-directory benchmark, without modifying capture.
          let previousAuthorizationMs: number | undefined;
          if (kind === "directory" && directoryFiles) {
            const before = performance.now();
            await storage.authorizeDefault();
            await storage.authorizeDefault();
            previousAuthorizationMs = Math.round(
              performance.now() - before,
            );
          }
          const preparing = performance.now();
          const firstFrames: unknown[] = [];
          const firstAudio: unknown[] = [];
          const selected = {
            id: "source",
            name: `${kind}-${remote ? "remote" : camera ? "camera" : "local"}`,
            local: !remote,
            video: stream.getVideoTracks()[0],
            audio: stream.getAudioTracks(),
            available: () => true,
            encodedVideoSources:
              reuse || remote
                ? () =>
                    recordingMediaSources(
                      {
                        subscribe(consumer, signal) {
                          return taps
                            .get(
                              stream.getVideoTracks()[0],
                            )!
                            .subscribe({
                              ...consumer,
                              frame(packet) {
                                if (firstFrames.length < 8)
                                  firstFrames.push({
                                    ...packet,
                                    data: packet.data
                                      .byteLength,
                                  });
                                return consumer.frame(
                                  packet,
                                );
                              },
                            });
                        },
                      },
                      stream
                        .getAudioTracks()
                        .map((track) => ({
                          subscribe(consumer) {
                            return taps
                              .get(track)!
                              .subscribe({
                                ...consumer,
                                encodedAudio(packet) {
                                  if (firstAudio.length < 3)
                                    firstAudio.push({
                                      ...packet,
                                      data: packet.data
                                        .byteLength,
                                    });
                                  return consumer.encodedAudio?.(
                                    packet,
                                  );
                                },
                              });
                          },
                        })),
                    )
                : undefined,
          };
          await service.start(selected);
          assert(
            !(reuse || remote) ||
              (encoders === 0 &&
                webCodecsEncoders === 0 &&
                (!remote || audioEncoders === 0)),
            `${remote ? "Receiver" : "Sender"} ${negotiatedCodec} recording fell back: recorders=${encoders}, video=${webCodecsEncoders}, audio=${audioEncoders}, frames=${JSON.stringify(firstFrames)}, audioFrames=${JSON.stringify(firstAudio)}`,
          );
          const prepareMs = Math.round(
            performance.now() - preparing,
          );
          const started = performance.now();
          let pausedMs = 0;
          let pausedSince: number | undefined;
          const pauseFor = async (
            ms: number,
            resume: boolean,
          ) => {
            pausedSince = performance.now();
            const before =
              reuse || remote ? await decodedFrames() : 0;
            service!.pause();
            const paused = state as RecordingState | null;
            assert(
              paused?.phase === "paused",
              `Recording did not pause: state=${JSON.stringify(state)}, error=${String(error)}, completed=${completions}, frames=${JSON.stringify(firstFrames)}`,
            );
            await sleep(ms);
            if (reuse || remote)
              assert(
                (await decodedFrames()) > before,
                "Pausing recording stopped remote decoding",
              );
            assert(
              (state as RecordingState | null)?.elapsed ===
                paused.elapsed,
              "Paused recording time kept advancing",
            );
            assert(
              stream
                .getTracks()
                .every(
                  (track) => track.readyState === "live",
                ),
              "Pause stopped a source track",
            );
            if (resume) {
              pausedMs += performance.now() - pausedSince;
              service!.resume();
              pausedSince = undefined;
              assert(
                (state as RecordingState | null)?.phase ===
                  "recording",
                "Recording did not resume",
              );
            }
          };
          const heap = [heapSize()];
          const memoryTimer = setInterval(
            () => heap.push(heapSize()),
            1000,
          );
          try {
            await sleep(duration / 2);
            await pauseFor(1500, true);
            await sleep(duration / 2);
            // Also exercise final data delivery when stopping a paused recorder.
            if (remote || reuse) await pauseFor(300, false);
          } finally {
            clearInterval(memoryTimer);
          }
          heap.push(heapSize());
          const during = state as RecordingState | null;
          if (!during?.bytes && remote)
            await waitFor(
              () =>
                !!(state as RecordingState | null)?.bytes,
              10000,
            ).catch(() => {});
          const incomingStats = [
            ...(await receiver.getStats()).values(),
          ].filter((stat) => stat.type === "inbound-rtp");
          assert(
            (state as RecordingState | null)?.bytes,
            `Media was not written while recording: ${kind}, remote=${remote}, ${JSON.stringify(state)}, ${String(error)}, audio=${audio.state}, stats=${JSON.stringify(incomingStats)}`,
          );
          const draft = await storage.synchronize();
          // Directory iterations also contain earlier completed recordings.
          const infos = await Promise.all(
            draft.files.map(async (id) => {
              const cache = await storage.createCache(id, {
                memoryChunks: 0,
                isRetained: () => false,
              });
              try {
                return await cache.getInfo();
              } finally {
                cache.dispose?.();
              }
            }),
          );
          assert(
            infos.filter(
              (info) =>
                info?.isComplete === false && !info.file,
            ).length === 1,
            "Recording did not have exactly one incomplete draft",
          );
          assert(
            /\.(webm|mkv|mp4)$/.test(
              infos.find(
                (info) => info?.isComplete === false,
              )?.fileName ?? "",
            ),
            "Recording draft did not display its final video filename",
          );
          assert(
            infos.every(
              (info) =>
                !info?.fileName.startsWith(".") &&
                !info?.fileName.endsWith(".crswap"),
            ),
            "Hidden or browser transaction files entered the library",
          );
          const stopping = performance.now();
          if (pausedSince !== undefined)
            pausedMs += stopping - pausedSince;
          const activeDurationMs =
            stopping - started - pausedMs;
          await service.stop();
          if (reuse || remote) {
            const before = await decodedFrames();
            await waitFor(
              async () =>
                (await decodedFrames()) > before + 3,
            );
          }
          assert(
            !error && saved,
            `Recording failed: ${String(error)}`,
          );
          assert(
            outputs === 1 && completions === 1,
            "Pause/resume created more than one output file",
          );
          assert(
            stream.getVideoTracks()[0].readyState ===
              "live",
            "Recorder stopped the original video",
          );
          assert(
            stream.getAudioTracks()[0].readyState ===
              "live",
            "Recorder stopped the original audio",
          );
          if (remote)
            assert(
              audioEncoders === 0,
              `Audio fell back: frames=${JSON.stringify(firstFrames)}, audio=${JSON.stringify(firstAudio)}, sync=${JSON.stringify(receiver.getReceivers().map((entry) => entry.getSynchronizationSources()))}`,
            );
          const file = saved as StoredFile;
          assert(
            file.name.endsWith(
              `.${recordingFormat(file.type).extension}`,
            ),
            "Recorded file extension does not match its actual format",
          );
          if (container !== "auto")
            assert(
              file.name.endsWith(`.${container}`),
              "Recording did not honor the selected container",
            );
          if (container === "auto")
            assert(
              !file.name.endsWith(".webm"),
              "Automatic recording still produced WebM",
            );
          if ((remote || reuse) && container === "auto") {
            const expected =
              negotiatedCodec === "video/H264"
                ? "mp4"
                : "mkv";
            assert(
              file.name.endsWith(`.${expected}`),
              `Wrong automatic container for ${negotiatedCodec}: ${file.name}`,
            );
            assert(
              file.type.includes(
                (
                  {
                    "video/H264": "avc1",
                    "video/VP8": "vp8",
                    "video/VP9": "vp09",
                    "video/AV1": "av01",
                  } as Record<string, string>
                )[negotiatedCodec!],
              ),
              `Remote ${codec} was unnecessarily transcoded: ${file.type}`,
            );
          }
          const measurement = {
            container,
            kind,
            remote,
            camera,
            codec,
            senderEncodingReused: reuse,
            receiverEncodingReused: remote,
            additionalAudioEncoders: audioEncoders,
            additionalVideoEncoders:
              encoders + webCodecsEncoders,
            type: file.type,
            bytes: file.size,
            prepareMs,
            ...(previousAuthorizationMs === undefined
              ? {}
              : {
                  directoryFiles,
                  previousAuthorizationMs,
                }),
            durationMs: duration,
            activeDurationMs: Math.round(activeDurationMs),
            pausedMs: Math.round(pausedMs),
            stoppedWhilePaused: remote || reuse,
            audioDurationSeconds: 0,
            audioSyncChecks: 0,
            videoDurationSeconds: 0,
            seekPoints: 0,
            seeks: [] as {
              target: number;
              decoded: number;
            }[],
            jsHeapBytes: {
              start: heap[0],
              end: heap.at(-1),
              peak: Math.max(
                ...heap.filter(
                  (value): value is number =>
                    value !== undefined,
                ),
              ),
            },
            stopMs: Math.round(
              performance.now() - stopping,
            ),
          };
          measurements.push(measurement);
          if (camera) {
            const receivedFrames =
              async (): Promise<number> => {
                const stats = [
                  ...(await receiver.getStats()).values(),
                ];
                return (
                  stats.find(
                    (entry) =>
                      entry.type === "inbound-rtp" &&
                      entry.kind === "video",
                  )?.framesReceived ?? 0
                );
              };
            const before = await receivedFrames();
            assert(
              before > 0,
              "Camera sharing stopped during recording",
            );
            await waitFor(
              async () => (await receivedFrames()) > before,
            );
          }
          const player = document.createElement("video");
          const poster = await videoThumbnail(
            file,
            new AbortController().signal,
          );
          const bitmap = await createImageBitmap(poster);
          assert(
            bitmap.width > 0 && bitmap.height > 0,
            "Recorded video has no decodable thumbnail",
          );
          const sample = new OffscreenCanvas(1, 1);
          const pixels = sample.getContext("2d")!;
          pixels.drawImage(bitmap, 0, 0, 1, 1);
          const color = pixels.getImageData(
            0,
            0,
            1,
            1,
          ).data;
          assert(
            Math.max(color[0], color[1], color[2]) > 30,
            "Recorded thumbnail is a blank frame",
          );
          bitmap.close();
          player.muted = true;
          const content = await file.arrayBuffer();
          if (
            recordingFormat(file.type).extension !== "mp4"
          ) {
            measurement.seekPoints =
              countSeekPoints(content);
            assert(
              measurement.seekPoints >=
                (duration >= 10000 ? 2 : 1),
              "WebM seek points do not span the recording",
            );
          }
          const decodedAudio = await audio.decodeAudioData(
            content.slice(0),
          );
          measurement.audioDurationSeconds =
            decodedAudio.duration;
          if (remote && negotiatedCodec === "video/VP8")
            measurement.audioSyncChecks =
              await checkRecordingAudioSync(
                content,
                decodedAudio,
              );
          assert(
            Math.abs(
              decodedAudio.duration -
                activeDurationMs / 1000,
            ) < 0.5,
            `Recording audio included paused time or lost a segment: ${kind}, ${codec}, active=${activeDurationMs}, audio=${decodedAudio.duration}, paused=${pausedMs}`,
          );
          const samples = decodedAudio.getChannelData(0);
          const rms = Math.sqrt(
            samples.reduce(
              (sum, sample) => sum + sample * sample,
              0,
            ) / samples.length,
          );
          assert(
            decodedAudio.duration > 2 && rms > 0.1,
            `Recording lost the selected source's audio: ${kind}, remote=${remote}, duration=${decodedAudio.duration}, rms=${rms}, stats=${JSON.stringify([...(await sender.getStats()).values()].filter((stat) => stat.kind === "audio"))}, inbound=${JSON.stringify(incomingStats.filter((stat) => stat.kind === "audio"))}`,
          );
          // Exercise the same preview entry point as the UI, including paged IndexedDB files.
          const url = await fileObjectUrl(file);
          try {
            player.src = url;
            await waitFor(() => player.readyState >= 1);
            assert(
              Number.isFinite(player.duration) &&
                player.duration > 0 &&
                Math.abs(
                  player.duration - activeDurationMs / 1000,
                ) < 1,
              `Recording has no finite duration: ${kind}, remote=${remote}, duration=${player.duration}`,
            );
            measurement.videoDurationSeconds =
              player.duration;
            await player.play();
            await waitFor(() => player.currentTime > 0.5);
            assert(
              player.videoWidth === 640 &&
                player.videoHeight === 360,
              "Recorded resolution changed",
            );
            player.pause();
            for (const fraction of [0.8, 0.2, 0.6]) {
              const target = player.duration * fraction;
              const decoded = await seekFrame(
                player,
                target,
              );
              assert(
                Math.abs(player.currentTime - target) <
                  0.1 &&
                  player.readyState >= 2 &&
                  Math.abs(decoded - target) < 0.2,
                `Recording cannot seek: ${kind}, remote=${remote}, target=${target}, current=${player.currentTime}, decoded=${decoded}`,
              );
              measurement.seeks.push({ target, decoded });
            }
          } finally {
            player.pause();
            player.removeAttribute("src");
            player.load();
            revokeFileUrl(url);
          }
          if (
            (reuse || remote) &&
            kind === "indexeddb" &&
            negotiatedCodec === "video/VP8"
          ) {
            // The same sender transform must survive several recordings.
            await service.start(selected);
            await sleep(400);
            await service.stop();
            assert(
              Number(completions) === 2 && !error,
              "Repeated recording failed to save",
            );
            let failure: unknown;
            let failedState: RecordingState | null = null;
            const failed = new RecordingService({
              container: () => container,
              storage: {
                authorizeDefault: (options) =>
                  storage.authorizeDefault(options),
                createWritableFile: async (options) => {
                  const writer =
                    await storage.createWritableFile(
                      options,
                    );
                  return {
                    ...writer,
                    write: async () => {
                      throw new DOMException(
                        "Disk full",
                        "QuotaExceededError",
                      );
                    },
                  };
                },
              },
              changed: (value) => {
                failedState = value;
              },
              failed: (error) => {
                failure = error;
              },
              complete: async () => {
                throw new Error(
                  "Failed recording was published",
                );
              },
            });
            try {
              await failed.start(selected);
              await waitFor(
                () => !!failure && failedState === null,
              );
              const before = await decodedFrames();
              await waitFor(
                async () =>
                  (await decodedFrames()) > before + 3,
              );
              assert(
                stream
                  .getTracks()
                  .every(
                    (track) => track.readyState === "live",
                  ),
                "Storage failure stopped shared capture",
              );
            } finally {
              await failed.stop();
            }
            await service.start(selected);
            await sleep(400);
            if (reuse) {
              sender.close();
              encoded!.dispose();
            } else {
              receiver.close();
              for (const tap of taps.values())
                tap.dispose();
            }
            await waitFor(() => state === null);
            assert(
              Number(completions) === 3 && !error,
              "RTP disconnect did not save the existing recording",
            );
            assert(
              local.getVideoTracks()[0].readyState ===
                "live",
              "Recording disposal stopped the original camera",
            );
            assert(
              webCodecsEncoders === 0 && encoders === 0,
              "A repeated recording added a video encoder",
            );
            passed.push(
              `${remote ? "receiver" : "sender"} reuse survives repeated recordings and quota failure; connection disposal automatically saves without stopping borrowed capture`,
            );
          }
          passed.push(
            `${kind}: ${remote ? `received WebRTC ${codec}` : camera ? "getUserMedia camera with concurrent WebRTC sharing" : "local canvas"} video/audio recording, pause/resume into one file, ${remote ? "stop while paused, " : ""}streaming draft, finite active duration, forward/backward seeking, video thumbnail, final playback, source ownership`,
          );
        } finally {
          await service?.stop();
          sender.close();
          receiver.close();
          for (const tap of taps.values()) tap.dispose();
          window.AudioEncoder = AudioEncoderConstructor;
          window.VideoEncoder = VideoEncoderConstructor;
          viewer.pause();
          viewer.srcObject = null;
          viewer.remove();
          capture
            ?.getTracks()
            .forEach((track) => track.stop());
          storage.dispose();
        }
      }
    }
    measurements.push(
      ...(await checkNativeRecordingPackets(
        source.getVideoTracks()[0],
        audio,
        container,
      )),
    );
    passed.push(
      "native H.264/H.265 with sender Opus or PCM fallback shares muxing/VFS, keeps pause/resume duration and audio, and never creates a video encoder/local receiver",
    );
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      tests: passed.length,
      passed,
      measurements,
      storage:
        "real IndexedDB and OPFS; directory-picker permissions simulated",
      camera:
        "getUserMedia with Chromium's fake camera device",
    };
  } finally {
    clearInterval(timer);
    source.getTracks().forEach((track) => track.stop());
    oscillator.stop();
    await audio.close();
    window.showDirectoryPicker = picker;
    FileSystemHandle.prototype.queryPermission = query;
    FileSystemHandle.prototype.requestPermission = request;
    await root.removeEntry(handle.name, {
      recursive: true,
    });
  }
}
run().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
