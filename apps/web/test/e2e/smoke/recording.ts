import {
  RecordingService,
  type RecordingState,
} from "@/libs/application/recording-service";
import { FileStorageService } from "@/libs/infrastructure/vfs/file-storage";
import { VfsDatabase } from "@/libs/infrastructure/vfs/database";
import type { StoredFile } from "@weblink/platform";
import { videoThumbnail } from "@/libs/utils/video-thumbnail";
import {
  fileObjectUrl,
  revokeFileUrl,
} from "@/libs/utils/stored-file";
import {
  element,
  unsigned,
} from "@/libs/application/recording-ebml";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(
  ready: () => boolean,
  timeout = 10000,
) {
  const until = performance.now() + timeout;
  while (!ready()) {
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
    "Saved WebM is missing SeekHead",
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
  const timer = setInterval(() => {
    context.fillStyle = `hsl(${frame++ % 360} 70% 40%)`;
    context.fillRect(0, 0, 640, 360);
    context.fillStyle = "white";
    context.fillText(String(frame), 40, 40);
  }, 33);
  const source = canvas.captureStream(30);
  const audio = new AudioContext();
  await audio.resume();
  const destination = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  oscillator.connect(destination);
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
    for (const kind of [
      "indexeddb",
      "directory",
    ] as const) {
      for (const remote of [false, true]) {
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
          receiver.ontrack = ({ track }) =>
            incoming.addTrack(track);
          if (remote) {
            source
              .getTracks()
              .forEach((track) =>
                sender.addTrack(track, source),
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
          const stream = remote ? incoming : source;
          let saved: StoredFile | undefined;
          let outputs = 0;
          let completions = 0;
          let error: unknown;
          let state: RecordingState | null = null;
          service = new RecordingService({
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
          await service.start({
            id: "source",
            name: `${kind}-${remote ? "remote" : "local"}`,
            video: stream.getVideoTracks()[0],
            audio: stream.getAudioTracks(),
            available: () => true,
          });
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
            service!.pause();
            const paused = state as RecordingState | null;
            assert(
              paused?.phase === "paused",
              "Recording did not pause",
            );
            await sleep(ms);
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
            if (remote) await pauseFor(300, false);
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
            /\.(webm|mp4)$/.test(
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
          const file = saved as StoredFile;
          const measurement = {
            kind,
            remote,
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
            stoppedWhilePaused: remote,
            audioDurationSeconds: 0,
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
          if (file.type.startsWith("video/webm")) {
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
          assert(
            Math.abs(
              decodedAudio.duration -
                activeDurationMs / 1000,
            ) < 0.5,
            `Recording audio included paused time or lost a segment: active=${activeDurationMs}, audio=${decodedAudio.duration}, paused=${pausedMs}`,
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
          passed.push(
            `${kind}: ${remote ? "received WebRTC" : "local"} video/audio recording, pause/resume into one file, ${remote ? "stop while paused, " : ""}streaming draft, finite active duration, forward/backward seeking, video thumbnail, final playback, source ownership`,
          );
        } finally {
          await service?.stop();
          sender.close();
          receiver.close();
          storage.dispose();
        }
      }
    }
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      tests: passed.length,
      passed,
      measurements,
      storage:
        "real IndexedDB and OPFS; directory-picker permissions simulated",
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
