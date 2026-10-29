import { createUuid } from "@/libs/domain/ids";
import type {
  NativeCapture,
  CaptureOptions,
  NativeScreenShare,
  NativeScreenOptions,
  NativeScreenPreview,
  CaptureStatus,
} from "@weblink/platform";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";
import { readBrowserVideoStats } from "@/libs/domain/video-stats";
import { monitorNativeCapture } from "./native-capture-monitor";
import { createNativeCodecSelection } from "./native-codec-selection";
import { NativeScreenPeers } from "./native-screen-peers";
import { openNativeRecordingStream } from "./native-recording-stream";

import type { NativeScreenPublication } from "@/libs/domain/native-screen/session";
const publications = new WeakMap<
  MediaStreamTrack,
  NativeScreenPublication
>();
export const getNativeScreenPublication = (
  track: MediaStreamTrack,
) => publications.get(track);
const captureDiagnostics = new WeakMap<
  MediaStreamTrack,
  () => CaptureStatus
>();
export const getNativeCaptureStatus = (
  track: MediaStreamTrack,
) => captureDiagnostics.get(track)?.();

/** Preserve browser capture identity while excluding native preview tracks. */
export function browserMediaStream(
  stream: MediaStream | null,
): MediaStream | null {
  if (!stream) return null;
  const tracks = stream.getTracks();
  const browserTracks = tracks.filter(
    (track) => !publications.has(track),
  );
  if (browserTracks.length === tracks.length) return stream;
  return browserTracks.length
    ? new MediaStream(browserTracks)
    : null;
}

/** Raw local presentation where supported, receive-only compatibility otherwise.
 * Rust publishes to peers directly; preview tracks never enter browser senders. */
export async function createNativeScreenStream(
  capture: NativeCapture,
  share: NativeScreenShare,
  sourceId: string,
  signal?: AbortSignal,
  options?: NativeScreenOptions,
  captureOptions?: CaptureOptions,
): Promise<MediaStream> {
  signal?.throwIfAborted();
  const status = await share.start(
    sourceId,
    options,
    captureOptions,
  );
  const id = status.sessionId;
  if (!id || status.state !== "running")
    throw new Error(
      status.error ?? "Native screen could not start",
    );
  const peerId = createUuid();
  let closed = false;
  let lastStatus = status;
  let audioQueue = Promise.resolve();
  let stopMonitoring: (() => void) | undefined;
  let preview: ScreenReceiver | undefined;
  let rawPreview: NativeScreenPreview | undefined;
  let stream: MediaStream;
  const previewAbort = new AbortController();
  const closing = new AbortController();
  let track: MediaStreamTrack | undefined;
  let originalStop: (() => void) | undefined;
  let answerApplied = false;
  const candidates: RTCIceCandidateInit[] = [];
  const peers = new NativeScreenPeers((peer) =>
    share.closePeer(id, peer),
  );
  const release = () => {
    if (closed) return;
    closed = true;
    // Notify every room sender before native shutdown can look like a failure.
    closing.abort();
    stopMonitoring?.();
    previewAbort.abort();
    rawPreview?.close();
    preview?.close();
    originalStop?.();
    // stop() itself emits no ended event. Notify the shared local stream owner on
    // native closure, lease failure and preview failure as well as user stop.
    track?.dispatchEvent(new Event("ended"));
    void capture.stop(id).catch(console.error);
  };
  signal?.addEventListener("abort", release, {
    once: true,
  });
  try {
    signal?.throwIfAborted();
    stopMonitoring = monitorNativeCapture(
      capture,
      id,
      (current) => {
        if (closed) return;
        lastStatus = current;
        if (current.state !== "running") {
          console.warn("Native capture ended", {
            state: current.state,
            error: current.error,
            stopReason: current.stopReason,
          });
          release();
        }
      },
    );
    if (closed) {
      stopMonitoring();
      throw new Error("Native screen closed");
    }
    if (share.preview) {
      rawPreview = await share.preview(
        id,
        options?.audio === true,
        release,
        previewAbort.signal,
      );
      if (closed) {
        rawPreview.close();
        throw new Error("Native screen closed");
      }
      stream = rawPreview.stream;
    } else {
      preview = new ScreenReceiver(
        { iceServers: [] },
        () => {},
        release,
        (candidate) => {
          if (closed) return;
          if (!answerApplied) {
            if (candidates.length < 256)
              candidates.push(candidate);
          } else
            void share
              .addIceCandidate(id, peerId, candidate)
              .catch(release);
        },
      );
      const sdp = await share.offer(
        id,
        peerId,
        [],
        false,
        true,
        (candidate) => {
          if (!closed)
            void preview
              ?.addIceCandidate(candidate)
              .catch(release);
        },
      );
      if (closed) throw new Error("Native screen closed");
      await share.answer(
        id,
        peerId,
        await preview.answer(sdp),
      );
      answerApplied = true;
      for (const candidate of candidates.splice(0)) {
        if (closed) throw new Error("Native screen closed");
        await share.addIceCandidate(id, peerId, candidate);
      }
      await preview.connected(options?.audio === true);
      if (closed) throw new Error("Native screen closed");
      stream = preview.stream;
    }
    if (closed) throw new Error("Native screen closed");
    track = stream.getVideoTracks()[0];
    if (!track)
      throw new Error("Native preview has no video track");
    originalStop = track.stop.bind(track);
    track.stop = release;
    const codecs = await createNativeCodecSelection(
      share,
      options,
    );
    if (closed) throw new Error("Native screen closed");
    let videoLimits = {
      maxWidth: options?.maxWidth ?? 1920,
      maxHeight: options?.maxHeight ?? 1080,
      frameRate: options?.frameRate ?? 30,
      maxBitrate: options?.maxBitrate ?? 25 * 1024 * 1024,
    };
    const publication: NativeScreenPublication = {
      videoLimits: share.updatePeerVideoSettings
        ? () => {
            const width =
              lastStatus.width ||
              lastStatus.source?.width ||
              videoLimits.maxWidth;
            const height =
              lastStatus.height ||
              lastStatus.source?.height ||
              videoLimits.maxHeight;
            const scale = Math.min(
              1,
              videoLimits.maxWidth / width,
              videoLimits.maxHeight / height,
            );
            return {
              ...videoLimits,
              maxWidth: Math.max(
                2,
                Math.floor((width * scale) / 2) * 2,
              ),
              maxHeight: Math.max(
                2,
                Math.floor((height * scale) / 2) * 2,
              ),
            };
          }
        : undefined,
      updatePeerVideoSettings: share.updatePeerVideoSettings
        ? async (peer, settings) => {
            if (closed)
              throw new Error("Native screen closed");
            await share.updatePeerVideoSettings!(
              id,
              peer,
              settings,
            );
          }
        : undefined,
      closing: closing.signal,
      getRecordingSources: () => {
        const recording = codecs.recording();
        return closed ||
          !share.subscribeRecording ||
          !recording
          ? []
          : [
              {
                // Local capture audio must outlive any individual viewer.
                encodedAudio: false,
                subscribe: (consumer, signal) =>
                  share.subscribeRecording!(
                    id,
                    consumer,
                    signal,
                    {
                      encodedAudio: false,
                      videoCodec: recording.video,
                    },
                  ),
              },
            ];
      },
      openRecording: (signal, ended) => {
        if (closed)
          return Promise.reject(
            new Error("Native screen closed"),
          );
        return openNativeRecordingStream(
          share,
          id,
          options,
          signal,
          ended,
        );
      },
      sourceId: createUuid(),
      controlEligible: status.source?.kind === "monitor",
      selectCodecs: codecs.select,
      getSenderStats: (
        peer = rawPreview ? undefined : peerId,
      ) =>
        closed || !peer
          ? Promise.resolve([])
          : (share.stats?.(id, peer) ??
            Promise.resolve([])),
      getPreviewStats: async () => {
        if (!closed && rawPreview)
          return [
            {
              key: rawPreview,
              direction: "receive",
              preview: true,
              samples: [rawPreview.stats()],
            },
          ];
        if (closed || !preview || !track) return [];
        const receiver = preview;
        const [sent, received] = await Promise.all([
          share.stats?.(id, peerId).catch(() => []) ?? [],
          readBrowserVideoStats(
            receiver.pc,
            track,
            "receive",
          ),
        ]);
        return [
          {
            key: peerId,
            direction: "send",
            preview: true,
            samples: sent,
          },
          {
            key: receiver.pc,
            direction: "receive",
            preview: true,
            samples: received,
          },
        ];
      },
      updateVideoSettings: async (settings) => {
        if (!closed) {
          await share.updateVideoSettings(id, settings);
          videoLimits = {
            maxWidth: settings.maxWidth,
            maxHeight: settings.maxHeight,
            frameRate: settings.frameRate,
            maxBitrate: settings.maxBitrate,
          };
        }
      },
      setAudioEnabled: (enabled) => {
        const update = audioQueue.then(async () => {
          if (!closed)
            await share.setAudioEnabled?.(id, enabled);
        });
        audioQueue = update.catch(() => {});
        return update.catch((error) => {
          release();
          throw error;
        });
      },
      offer: (
        peer,
        servers,
        relay,
        onCandidate,
        control,
        selected,
      ) =>
        peers.offer(peer, () => {
          if (closed)
            throw new Error("Native screen closed");
          return selected
            ? share.offer(
                id,
                peer,
                servers,
                relay,
                false,
                onCandidate,
                control,
                selected,
              )
            : control
              ? share.offer(
                  id,
                  peer,
                  servers,
                  relay,
                  false,
                  onCandidate,
                  control,
                )
              : onCandidate
                ? share.offer(
                    id,
                    peer,
                    servers,
                    relay,
                    false,
                    onCandidate,
                  )
                : share.offer(id, peer, servers, relay);
        }),
      answer: (peer, answer) =>
        share.answer(id, peer, answer),
      closePeer: (peer) => peers.close(peer),
      addIceCandidate: (peer, candidate) =>
        share.addIceCandidate(id, peer, candidate),
    };
    for (const previewTrack of stream.getTracks()) {
      publications.set(previewTrack, publication);
      captureDiagnostics.set(
        previewTrack,
        () => lastStatus,
      );
    }
    return stream;
  } catch (error) {
    release();
    throw error;
  } finally {
    // Once published, the local stream owner controls this capture's lifetime.
    signal?.removeEventListener("abort", release);
  }
}
