import {
  ENCODED_VIDEO_MAX_PENDING,
  type EncodedVideoPacket,
  type EncodedAudioPacket,
} from "./encoded-video";
import { recordingAudioFormat } from "@weblink/platform";

// The transform lives as long as the RTP endpoint. Recording only switches copying;
// detaching a transform can stop Chromium's RTP pipeline.
const scope = self as unknown as DedicatedWorkerGlobalScope;
scope.addEventListener("rtctransform", (event: Event) => {
  const transformer = (
    event as Event & {
      transformer: {
        readable: ReadableStream<
          RTCEncodedVideoFrame | RTCEncodedAudioFrame
        >;
        writable: WritableStream<
          RTCEncodedVideoFrame | RTCEncodedAudioFrame
        >;
        options: {
          port: MessagePort;
          kind?: string;
          direction?: string;
        };
        generateKeyFrame?: () => Promise<number>;
        sendKeyFrameRequest?: () => Promise<void>;
      };
    }
  ).transformer;
  const port = transformer.options.port;
  const audio = transformer.options.kind === "audio";
  let codecs: RTCRtpCodecParameters[] = [];
  let id = 0;
  let active = false;
  let waitingKey = true;
  let pending = 0;
  let pendingPackets = 0;
  let segment = 0;
  let dimensions = { width: 0, height: 0, ssrc: 0 };
  const notify = (
    message: unknown,
    transfer: Transferable[] = [],
  ) => {
    try {
      port.postMessage(message, transfer);
    } catch {
      active = false;
    }
  };
  port.onmessage = ({ data }) => {
    if (data.command === "start") {
      id = data.id;
      pending = 0;
      pendingPackets = 0;
      segment = 0;
      codecs = data.codecs ?? [];
    }
    if (data.id !== id) return;
    if (data.command === "ack") {
      pending = Math.max(0, pending - data.bytes);
      pendingPackets = Math.max(0, pendingPackets - 1);
      return;
    }
    active = data.command === "resume";
    if (active) {
      waitingKey = true;
      segment++;
      // Firefox provides this; Chromium uses sender.setParameters instead.
      if (!audio) {
        if (transformer.options.direction === "receive")
          void transformer
            .sendKeyFrameRequest?.()
            .catch(() => {});
        else
          void transformer
            .generateKeyFrame?.()
            .catch(() => {});
      }
    }
    notify({ id, command: data.command });
  };
  transformer.readable
    .pipeThrough(
      new TransformStream<
        RTCEncodedVideoFrame | RTCEncodedAudioFrame
      >({
        transform(frame, controller) {
          let packet:
            | EncodedVideoPacket
            | EncodedAudioPacket
            | undefined;
          try {
            const video = frame as RTCEncodedVideoFrame;
            if (
              active &&
              (audio ||
                video.type === "key" ||
                video.type === "delta") &&
              (audio || !waitingKey || video.type === "key")
            ) {
              const metadata =
                frame.getMetadata() as RTCEncodedVideoFrameMetadata & {
                  captureTime?: number;
                  senderCaptureTimeOffset?: number;
                };
              const bytes = frame.data.byteLength;
              if (!bytes) return;
              if (
                pendingPackets >= 512 ||
                pending + bytes > ENCODED_VIDEO_MAX_PENDING
              )
                throw new Error(
                  "Recording storage cannot keep up; encoded recording stopped before exhausting memory",
                );
              const codec = codecs.find(
                (entry) =>
                  entry.payloadType ===
                  metadata.payloadType,
              );
              const ssrc =
                metadata.synchronizationSource ?? 0;
              if (!audio) {
                if (dimensions.ssrc !== ssrc)
                  dimensions = {
                    width: 0,
                    height: 0,
                    ssrc,
                  };
                if (metadata.width)
                  dimensions.width = metadata.width;
                if (metadata.height)
                  dimensions.height = metadata.height;
              }
              const common = {
                data: frame.data.slice(0),
                timestamp: frame.timestamp,
                clockTime: Number.isFinite(
                  metadata.captureTime,
                )
                  ? performance.timeOrigin +
                    metadata.captureTime! +
                    (metadata.senderCaptureTimeOffset ?? 0)
                  : undefined,
                mimeType:
                  metadata.mimeType ??
                  codec?.mimeType ??
                  "",
                ssrc,
                segment,
              };
              const sound = audio
                ? recordingAudioFormat(
                    common.mimeType,
                    codec?.clockRate,
                    codec?.channels,
                  )
                : undefined;
              packet = audio
                ? {
                    ...common,
                    sampleRate:
                      sound?.sampleRate ??
                      codec?.clockRate ??
                      0,
                    clockRate:
                      sound?.clockRate ?? codec?.clockRate,
                    channelCount:
                      sound?.channelCount ??
                      codec?.channels ??
                      0,
                  }
                : {
                    ...common,
                    type: video.type as "key" | "delta",
                    width: dimensions.width,
                    height: dimensions.height,
                    spatialIndex:
                      metadata.spatialIndex ?? 0,
                  };
              pending += bytes;
              pendingPackets++;
              waitingKey = false;
            }
          } catch (error) {
            active = false;
            notify({ id, error: String(error) });
          } finally {
            // Storage, muxing and copying failures must never block the network.
            controller.enqueue(frame);
          }
          if (packet) notify({ id, packet }, [packet.data]);
        },
      }),
    )
    .pipeTo(transformer.writable)
    .catch((error) => notify({ id, error: String(error) }));
});
