import { invoke } from "@tauri-apps/api/core";
import type { NativePresentation } from "../presentation";

export interface RoomOutput {
  key: number;
  mid: string;
  stream: MediaStream;
  track?: MediaStreamTrack;
  ready: Promise<void>;
  audio(): void;
  stats(): Promise<Record<string, unknown> | undefined>;
  close(): void;
}
export function roomOutput(
  id: string,
  key: number,
  mid: string,
  kind: "audio" | "video",
  presentation: NativePresentation,
  changed: () => void,
  failed: (error: unknown) => void,
): RoomOutput {
  if (kind === "video") {
    const surface = presentation.create(
      `${id}/${key}`,
      false,
      changed,
      () => failed(new Error("Native surface ended")),
      failed,
    );
    return {
      key,
      mid,
      stream: surface.stream,
      track: surface.stream.getVideoTracks()[0],
      ready: surface.open().then(() => surface.ready),
      audio: () => {},
      stats: async () => ({
        mode: "gpu",
        slots: 0,
        renderer: await surface.stats(),
      }),
      close: () => surface.close(),
    };
  }
  const lifetime = new AbortController();
  const context = new AudioContext({
    sampleRate: 48000,
    latencyHint: "interactive",
  });
  const destination =
    context.createMediaStreamDestination();
  let node: AudioWorkletNode | undefined;
  let pending = false,
    running = false;
  const pump = async () => {
    if (
      running ||
      !node ||
      context.state !== "running" ||
      lifetime.signal.aborted
    )
      return;
    running = true;
    try {
      while (
        pending &&
        !lifetime.signal.aborted &&
        context.state === "running"
      ) {
        pending = false;
        const pcm = await invoke<ArrayBuffer>(
          "room_audio",
          { id, key },
        );
        if (pcm.byteLength && !lifetime.signal.aborted)
          node.port.postMessage(pcm, [pcm]);
      }
    } catch (error) {
      if (!lifetime.signal.aborted) failed(error);
    } finally {
      running = false;
    }
  };
  const resume = () => {
    if (context.state === "suspended")
      void context.resume().catch(failed);
  };
  const ready = context.audioWorklet
    .addModule(
      new URL(
        "../receive-audio.worklet.js?no-inline",
        import.meta.url,
      ).href,
    )
    .then(() => {
      if (lifetime.signal.aborted) return;
      node = new AudioWorkletNode(
        context,
        "weblink-receive-audio",
        {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        },
      );
      node.connect(destination);
      context.onstatechange = () => {
        pending = true;
        void pump();
      };
      document.addEventListener("pointerdown", resume, {
        capture: true,
        signal: lifetime.signal,
      });
      document.addEventListener("keydown", resume, {
        capture: true,
        signal: lifetime.signal,
      });
      resume();
      pending = true;
      void pump();
    });
  return {
    key,
    mid,
    stream: destination.stream,
    track: destination.stream.getAudioTracks()[0],
    ready,
    audio() {
      pending = true;
      void pump();
    },
    stats: async () => undefined,
    close() {
      lifetime.abort();
      context.onstatechange = null;
      node?.disconnect();
      destination.stream
        .getTracks()
        .forEach((t) => t.stop());
      void context.close().catch(() => {});
    },
  };
}
