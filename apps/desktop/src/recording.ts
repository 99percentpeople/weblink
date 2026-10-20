import { invoke } from "@tauri-apps/api/core";
import { RECORDING_AUDIO_CODECS } from "@weblink/platform";
import type {
  EncodedMediaConsumer,
  EncodedMediaSubscription,
  RecordingAudioFormat,
} from "@weblink/platform";

/** One binary read in flight; neither the IPC bridge nor the JS queue grows with recording length. */
export async function subscribeNativeRecording(
  sessionId: string,
  consumer: EncodedMediaConsumer,
  signal?: AbortSignal,
  options?: { encodedAudio?: boolean; videoCodec?: string },
): Promise<EncodedMediaSubscription | null> {
  signal?.throwIfAborted();
  const recordingId = crypto.randomUUID();
  const args = { sessionId, recordingId };
  let stopped = false;
  let ended = false;
  let segment = 0;
  let active = false;
  let controls = Promise.resolve();
  let reading: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const close = () =>
    invoke<void>("capture_recording_close", args);
  const fail = (error: unknown) => {
    if (stopped || ended) return;
    ended = true;
    consumer.ended(
      error instanceof Error
        ? error
        : new Error(String(error)),
    );
  };
  const stop = () =>
    (stopping ??= (async () => {
      stopped = true;
      signal?.removeEventListener("abort", aborted);
      await controls.catch(() => {});
      try {
        await reading;
      } finally {
        await close();
      }
    })());
  const aborted = () => {
    void stop().catch(() => {});
  };
  signal?.addEventListener("abort", aborted, {
    once: true,
  });
  let info: {
    audio: RecordingAudioFormat | null;
    encodedAudio?: boolean;
  } | null;
  try {
    info = await invoke("capture_recording_open", {
      ...args,
      encodedAudio: options?.encodedAudio ?? true,
      videoCodec: options?.videoCodec,
    });
    if (stopped || signal?.aborted) {
      await close();
      signal?.throwIfAborted();
      return null;
    }
    if (!info) {
      signal?.removeEventListener("abort", aborted);
      return null;
    }
  } catch (error) {
    signal?.removeEventListener("abort", aborted);
    await close().catch(() => {});
    throw error;
  }
  const control = (next: boolean) => {
    if (stopped || ended) return;
    active = next;
    if (active) segment++;
    const state = { ...args, active, segment };
    controls = controls.then(() =>
      invoke<void>("capture_recording_control", state),
    );
    void controls.catch(fail);
  };
  reading = (async () => {
    try {
      while (!stopped && !ended) {
        await controls;
        if (stopped || ended) break;
        const data = await invoke<ArrayBuffer>(
          "capture_recording_read",
          args,
        );
        // Deliver the accepted batch even if stop was clicked during the read.
        const view = new DataView(data);
        for (let at = 0; at < data.byteLength; ) {
          if (at + 36 > data.byteLength)
            throw new Error(
              "Truncated native recording header",
            );
          const size = view.getUint32(at, true);
          const end = at + 36 + size;
          if (end > data.byteLength)
            throw new Error(
              "Truncated native recording packet",
            );
          const packetSegment = view.getUint32(
            at + 4,
            true,
          );
          const kind = view.getUint8(at + 32);
          const bytes = data.slice(at + 36, end);
          if (kind === 2) {
            ended = true;
            const error = new TextDecoder().decode(bytes);
            if (!stopped)
              consumer.ended(
                error ? new Error(error) : undefined,
              );
            break;
          }
          if (
            packetSegment === segment &&
            (active || stopped)
          ) {
            const timestamp = Number(
              view.getBigInt64(at + 8, true),
            );
            if (kind === 0) {
              const codec = view.getUint8(at + 33);
              if (codec !== 1 && codec !== 2)
                throw new Error(
                  "Unsupported native recording codec",
                );
              await consumer.frame({
                data: bytes,
                timestamp,
                timestampScale: 1000000,
                clockTime: timestamp / 1000,
                mimeType:
                  codec === 1 ? "video/h264" : "video/h265",
                type: view.getUint8(at + 34)
                  ? "key"
                  : "delta",
                width: view.getUint32(at + 16, true),
                height: view.getUint32(at + 20, true),
                ssrc: 0,
                spatialIndex: 0,
                segment: packetSegment,
              });
            } else if (kind === 1) {
              await consumer.audio?.({
                data: bytes,
                timestamp,
                segment: packetSegment,
                sampleRate: view.getUint32(at + 24, true),
                channelCount: view.getUint32(at + 28, true),
              });
            } else if (kind === 3) {
              const format = RECORDING_AUDIO_CODECS.find(
                (codec) =>
                  codec.id === view.getUint8(at + 33),
              );
              if (!info.encodedAudio || !format)
                throw new Error(
                  "Unsupported native recording audio codec",
                );
              await consumer.encodedAudio?.({
                data: bytes,
                timestamp: view.getUint32(at + 16, true),
                clockTime: timestamp / 1000,
                mimeType: format.mimeType,
                clockRate: format.clockRate,
                ssrc: view.getUint32(at + 20, true),
                sampleRate: view.getUint32(at + 24, true),
                channelCount: view.getUint32(at + 28, true),
                segment: packetSegment,
              });
            } else
              throw new Error(
                "Unsupported native recording packet",
              );
          }
          at = end;
        }
      }
    } catch (error) {
      fail(error);
    }
  })();
  return {
    audioFormat: info.audio ?? undefined,
    encodedAudio: info.encodedAudio ?? false,
    pause: () => control(false),
    resume: () => control(true),
    stop,
  };
}
