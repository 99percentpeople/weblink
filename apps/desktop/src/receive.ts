import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeScreenReceive,
  NativeReceiveEvent,
} from "@weblink/platform";
import { createPreviewTrack } from "./preview-track";

interface SharedEvent {
  additionalData?: { kind?: string; id?: string };
  getBuffer(): ArrayBuffer;
}
interface SharedWebview {
  addEventListener(
    type: "sharedbufferreceived",
    listener: (e: SharedEvent) => void,
  ): void;
  removeEventListener(
    type: "sharedbufferreceived",
    listener: (e: SharedEvent) => void,
  ): void;
  releaseBuffer(buffer: ArrayBuffer): void;
}
interface Frame {
  sequence: number;
  width: number;
  height: number;
  format: "NV12" | "I420";
  colorSpace?: VideoColorSpaceInit | null;
}
type Event =
  | NativeReceiveEvent
  | { type: "frame" | "audio" | "audio-track" };

export function createNativeScreenReceive(
  watchVisibility: (
    changed: (visible: boolean) => void,
  ) => () => void,
): NativeScreenReceive {
  return {
    codecs: () => invoke<string[]>("receive_codecs"),
    async open(configuration, onEvent, signal) {
      signal.throwIfAborted();
      const webview = (
        window as Window & {
          chrome?: { webview?: SharedWebview };
        }
      ).chrome?.webview;
      if (
        !webview?.releaseBuffer ||
        typeof VideoFrame === "undefined"
      )
        throw new Error(
          "Native receiving requires WebView2 shared buffers",
        );
      const id = crypto.randomUUID();
      const presenter = createPreviewTrack();
      const stream = presenter.stream;
      let closed = false;
      let initialized = false;
      let buffer: ArrayBuffer | undefined;
      let sequence = 0;
      let dirty = false;
      let running = false;
      let visibilityUpdate = Promise.resolve();
      let nativeVisible = true;
      let opening: Promise<unknown> | undefined;
      let heartbeat:
        | ReturnType<typeof setInterval>
        | undefined;
      let refresh:
        | ReturnType<typeof setInterval>
        | undefined;
      let unwatch: (() => void) | undefined;
      let audioContext: AudioContext | undefined;
      let audioNode: AudioWorkletNode | undefined;
      let audioReady: Promise<void> | undefined;
      let audioRunning = false;
      let audioDirty = false;
      let ready!: () => void;
      let rejectReady!: (error: unknown) => void;
      const mapped = new Promise<void>(
        (resolve, reject) => {
          ready = resolve;
          rejectReady = reject;
        },
      );
      void mapped.catch(() => {});
      const timeout = setTimeout(
        () =>
          rejectReady(
            new Error("Native receive buffer timed out"),
          ),
        10000,
      );
      const visible = () =>
        nativeVisible && !document.hidden;
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(timeout);
        clearInterval(heartbeat);
        clearInterval(refresh);
        rejectReady(
          new DOMException("Receiver closed", "AbortError"),
        );
        signal.removeEventListener("abort", close);
        document.removeEventListener(
          "visibilitychange",
          visibilityChanged,
        );
        document.removeEventListener(
          "pointerdown",
          resumeAudio,
          true,
        );
        document.removeEventListener(
          "keydown",
          resumeAudio,
          true,
        );
        unwatch?.();
        presenter.close();
        audioNode?.disconnect();
        for (const track of stream.getAudioTracks())
          track.stop();
        void audioContext?.close().catch(() => {});
        if (buffer) {
          webview.releaseBuffer(buffer);
          buffer = undefined;
        }
        void (opening ?? Promise.resolve())
          .catch(() => {})
          .then(() => invoke("receive_close", { id }))
          .catch(console.warn)
          .finally(() =>
            webview.removeEventListener(
              "sharedbufferreceived",
              received,
            ),
          );
      };
      const fail = (error: unknown) => {
        if (closed) return;
        onEvent({ type: "error", error: String(error) });
        close();
      };
      const pump = async () => {
        if (
          running ||
          closed ||
          !initialized ||
          !buffer ||
          !visible()
        )
          return;
        running = true;
        try {
          while (dirty && !closed && visible()) {
            dirty = false;
            const frame = await invoke<Frame | null>(
              "receive_frame",
              { id, after: sequence },
            );
            if (closed || !buffer || !visible()) break;
            if (!frame) continue;
            if (
              !Number.isInteger(frame.width) ||
              !Number.isInteger(frame.height) ||
              frame.width < 2 ||
              frame.height < 2 ||
              frame.width > 3840 ||
              frame.height > 2160 ||
              frame.width % 2 ||
              frame.height % 2 ||
              !["I420", "NV12"].includes(frame.format)
            )
              throw new Error(
                "Invalid native receive frame",
              );
            const pixels = new VideoFrame(buffer, {
              format: frame.format,
              codedWidth: frame.width,
              codedHeight: frame.height,
              timestamp: Math.round(
                performance.now() * 1000,
              ),
              colorSpace: frame.colorSpace ?? undefined,
            });
            try {
              await presenter.write(pixels);
            } finally {
              pixels.close();
            }
            const first = sequence === 0;
            sequence = frame.sequence;
            if (first) onEvent({ type: "track" });
          }
        } catch (error) {
          fail(error);
        } finally {
          running = false;
        }
      };
      const visibilityChanged = () => {
        if (!initialized || closed) return;
        visibilityUpdate = visibilityUpdate
          .then(() => {
            if (!closed)
              return invoke<void>("receive_visible", {
                id,
                visible: visible(),
              });
          })
          .then(() => {
            dirty = true;
            void pump();
          })
          .catch(fail);
      };
      const received = (event: SharedEvent) => {
        if (
          event.additionalData?.kind !==
            "weblink-receive" ||
          event.additionalData.id !== id
        )
          return;
        const value = event.getBuffer();
        if (closed || buffer) {
          webview.releaseBuffer(value);
          return;
        }
        buffer = value;
        ready();
      };
      const prepareAudio = () =>
        (audioReady ??= (async () => {
          audioContext = new AudioContext({
            sampleRate: 48000,
            latencyHint: "interactive",
          });
          audioContext.onstatechange = () => {
            if (audioContext?.state === "running") {
              audioDirty = true;
              void pumpAudio();
            }
          };
          await audioContext.audioWorklet.addModule(
            new URL(
              "./receive-audio.worklet.js?no-inline",
              import.meta.url,
            ).href,
          );
          if (closed) return;
          audioNode = new AudioWorkletNode(
            audioContext,
            "weblink-receive-audio",
            {
              numberOfInputs: 0,
              numberOfOutputs: 1,
              outputChannelCount: [2],
            },
          );
          const destination =
            audioContext.createMediaStreamDestination();
          audioNode.connect(destination);
          stream.addTrack(
            destination.stream.getAudioTracks()[0],
          );
          if (!closed) onEvent({ type: "track" });
          resumeAudio();
        })());
      const resumeAudio = () => {
        if (!closed && audioContext?.state === "suspended")
          void audioContext.resume().catch(fail);
      };
      const pumpAudio = async () => {
        if (audioRunning || closed) return;
        audioRunning = true;
        try {
          await prepareAudio();
          // Keep the bounded native queue while autoplay is suspended. Posting
          // to a suspended worklet could accumulate unbounded port messages.
          if (audioContext?.state !== "running") return;
          while (audioDirty && !closed) {
            audioDirty = false;
            const data = await invoke<ArrayBuffer>(
              "receive_audio",
              { id },
            );
            if (!closed && data.byteLength)
              audioNode?.port.postMessage(data, [data]);
          }
        } catch (error) {
          fail(error);
        } finally {
          audioRunning = false;
        }
      };
      webview.addEventListener(
        "sharedbufferreceived",
        received,
      );
      document.addEventListener(
        "pointerdown",
        resumeAudio,
        true,
      );
      document.addEventListener(
        "keydown",
        resumeAudio,
        true,
      );
      signal.addEventListener("abort", close, {
        once: true,
      });
      try {
        const events = new Channel<Event>((event) => {
          if (closed) return;
          if (event.type === "frame") {
            dirty = true;
            void pump();
          } else if (event.type === "audio") {
            audioDirty = true;
            void pumpAudio();
          } else if (event.type === "audio-track") {
            void prepareAudio().catch(fail);
          } else onEvent(event as NativeReceiveEvent);
        });
        opening = invoke("receive_open", {
          id,
          events,
          relayOnly:
            configuration.iceTransportPolicy === "relay",
          iceServers: (configuration.iceServers ?? []).map(
            (s) => ({
              urls:
                typeof s.urls === "string"
                  ? [s.urls]
                  : s.urls,
              username: s.username ?? "",
              credential: s.credential ?? "",
            }),
          ),
        });
        await Promise.all([opening, mapped]);
        clearTimeout(timeout);
        signal.throwIfAborted();
        if (closed)
          throw new Error(
            "Native receiver closed during startup",
          );
        initialized = true;
        document.addEventListener(
          "visibilitychange",
          visibilityChanged,
        );
        unwatch = watchVisibility((value) => {
          nativeVisible = value;
          visibilityChanged();
        });
        visibilityChanged();
        heartbeat = setInterval(() => {
          void invoke("receive_renew", { id }).catch(fail);
        }, 10000);
        refresh = setInterval(() => {
          if (!running && visible() && !closed) {
            running = true;
            void presenter
              .refresh()
              .catch(fail)
              .finally(() => {
                running = false;
                if (dirty) void pump();
              });
          }
        }, 500);
        return {
          stream,
          answer: (sdp) =>
            invoke("receive_answer", { id, sdp }),
          addIceCandidate: (candidate) =>
            invoke("receive_candidate", { id, candidate }),
          stats: () => invoke("receive_stats", { id }),
          send: (label, data) =>
            invoke("receive_send", { id, label, data }),
          close,
        };
      } catch (error) {
        close();
        throw error;
      }
    },
  };
}
