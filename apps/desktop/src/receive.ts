import type { NativePresentation } from "./presentation";
import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeScreenReceive,
  NativeReceiveEvent,
} from "@weblink/platform";
import { createPreviewTrack } from "./preview-track";
import {
  createReceiveVideo,
  type ReceiveFrame,
  type SharedEvent,
  type SharedWebview,
} from "./receive-video";

type Event =
  | NativeReceiveEvent
  | ReceiveFrame
  | { type: "audio" | "audio-track" };

export function createNativeScreenReceive(
  watchVisibility: (
    changed: (visible: boolean) => void,
  ) => () => void,
  presentation?: NativePresentation,
): NativeScreenReceive {
  // Fail closed until discovery identifies an unsupported desktop platform.
  // Windows keeps native receiving even when discovery or a decoder fails.
  let allowBrowserFallback = false;
  return {
    get allowBrowserFallback() {
      return allowBrowserFallback;
    },
    codecs: async () => {
      const runtime = await invoke<{ os: string }>(
        "runtime_capabilities",
      );
      allowBrowserFallback = runtime.os !== "windows";
      return invoke<string[]>("receive_codecs");
    },
    async open(configuration, onEvent, signal) {
      signal.throwIfAborted();
      const runtime = window as Window & {
        chrome?: { webview?: SharedWebview };
        __WEBLINK_RECEIVE_RELEASE__?: (
          id: string,
          releases: { slot: number; lease: number }[],
        ) => void;
      };
      const webview = runtime.chrome?.webview;
      const returnSlots =
        runtime.__WEBLINK_RECEIVE_RELEASE__;
      if (
        !presentation &&
        (!webview?.releaseBuffer ||
          !returnSlots ||
          typeof VideoFrame === "undefined")
      )
        throw new Error(
          "Native receiving requires WebView2 shared buffers",
        );
      const id = crypto.randomUUID();
      const surface = presentation?.create(
        id,
        false,
        () => onEvent({ type: "track" }),
        () => fail(new Error("Native surface ended")),
        (error) => fail(error),
      );
      const presenter = surface
        ? undefined
        : createPreviewTrack();
      const stream = surface?.stream ?? presenter!.stream;
      let closed = false;
      let initialized = false;
      let visibilityUpdate = Promise.resolve();
      let nativeVisible = true;
      let opening: Promise<unknown> | undefined;
      let heartbeat:
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
        video.close();
        audioNode?.disconnect();
        for (const track of stream.getAudioTracks())
          track.stop();
        void audioContext?.close().catch(() => {});
        void (opening ?? Promise.resolve())
          .catch(() => {})
          .then(() => invoke("receive_close", { id }))
          .catch(console.warn)
          .finally(() =>
            webview?.removeEventListener(
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
      const video = surface
        ? {
            close: () => surface.close(),
            received: (_event: SharedEvent) => {},
            frame: (_event: ReceiveFrame) => {},
            start: () => {},
            visibilityChanged: () => {},
            stats: () =>
              surface.latestStats ?? {
                path: "d3d11-composition",
              },
          }
        : createReceiveVideo({
            id,
            webview: webview!,
            presenter: presenter!,
            returnSlots: (releases) =>
              returnSlots!(id, releases),
            visible,
            mapped: ready,
            track: () => onEvent({ type: "track" }),
            fail,
          });
      const visibilityChanged = () => {
        if (!initialized || closed) return;
        if (!visible()) video.visibilityChanged();
        visibilityUpdate = visibilityUpdate
          .then(() => {
            if (!closed)
              return invoke<void>("receive_visible", {
                id,
                visible: visible(),
              });
          })
          .then(() => video.visibilityChanged())
          .catch(fail);
      };
      const received = (event: SharedEvent) =>
        video.received(event);
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
      webview?.addEventListener(
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
            video.frame(event);
          } else if (event.type === "audio") {
            audioDirty = true;
            void pumpAudio();
          } else if (event.type === "audio-track") {
            void prepareAudio().catch(fail);
          } else onEvent(event as NativeReceiveEvent);
        });
        opening = invoke("receive_open", {
          id,
          gpu: !!surface,
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
        if (surface)
          await Promise.race([
            opening.then(() => surface.open()),
            mapped,
          ]);
        else await Promise.all([opening, mapped]);
        clearTimeout(timeout);
        signal.throwIfAborted();
        if (closed)
          throw new Error(
            "Native receiver closed during startup",
          );
        initialized = true;
        video.start();
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
        return {
          stream,
          answer: (sdp) =>
            invoke("receive_answer", { id, sdp }),
          addIceCandidate: (candidate) =>
            invoke("receive_candidate", { id, candidate }),
          stats: async () => {
            if (surface) await surface.stats();
            const reports = await invoke<
              (RTCStats & Record<string, unknown>)[]
            >("receive_stats", { id });
            return reports.map((report) =>
              report.type === "inbound-rtp" &&
              report.kind === "video"
                ? {
                    ...report,
                    nativeReceive: {
                      ...(report.nativeReceive as
                        | Record<string, unknown>
                        | undefined),
                      renderer: video.stats(),
                    },
                  }
                : report,
            );
          },
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
