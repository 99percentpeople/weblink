import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
} from "solid-js";
import type {
  AudioCaptureFormat,
  CaptureCapabilities,
  NativeEncoder,
  PlatformRuntime,
} from "@weblink/platform";
import type { AppPermissions } from "./create-app-permissions";
import { browserAudioCodecs } from "@/libs/application/meeting-audio-settings";
import { browserAudioSampling } from "@/libs/application/audio-sampling-capabilities";
import {
  defaultVideoFrameRates,
  displayVideoFrameRates,
} from "@/libs/application/meeting-video-settings";

export interface NativeMediaCapabilitiesSnapshot {
  codecs: string[];
  encoders: NativeEncoder[];
  backends: CaptureCapabilities;
  failed: boolean;
  encodingLoading?: boolean;
  backendsLoading?: boolean;
  backendsFailed?: boolean;
}

/** AppState owns discovery and listeners. Views only consume these accessors. */
export function createAppMediaCapabilities(options: {
  platform: PlatformRuntime;
  permissions: Pick<
    AppPermissions["media"],
    "devices" | "state"
  >;
  stream: Accessor<MediaStream | null>;
}) {
  const runtime = options.platform;
  const [native, setNative] =
    createSignal<NativeMediaCapabilitiesSnapshot | null>(
      runtime.kind === "desktop"
        ? {
            codecs: [],
            encoders: [],
            backends: { screen: [], window: [] },
            failed: false,
            encodingLoading: true,
            backendsLoading: true,
          }
        : null,
    );
  const [frameRates, setFrameRates] = createSignal<
    readonly number[] | null
  >(
    runtime.kind === "desktop"
      ? null
      : defaultVideoFrameRates,
  );
  const [audioCodecs, setAudioCodecs] = createSignal<
    string[]
  >([]);
  const [audioCodecsLoading, setAudioCodecsLoading] =
    createSignal(runtime.kind === "desktop");
  let audioCodecsFailed = false;
  const [audioFormats, setAudioFormats] =
    createSignal<AudioCaptureFormat[]>();
  const [audioFormatsLoading, setAudioFormatsLoading] =
    createSignal(runtime.kind === "desktop");
  const [audioFormatsFailed, setAudioFormatsFailed] =
    createSignal(false);
  const [microphoneId, setMicrophoneId] = createSignal("");
  const [revision, setRevision] = createSignal(0);
  const refreshTracks = () =>
    setRevision((value) => value + 1);
  const browserCodecs = browserAudioCodecs();
  let videoCodecs: string[] = [];
  try {
    videoCodecs =
      RTCRtpSender.getCapabilities("video")
        ?.codecs.map((codec) =>
          codec.mimeType.toLowerCase(),
        )
        .filter(
          (codec) =>
            ![
              "video/rtx",
              "video/red",
              "video/ulpfec",
              "video/flexfec-03",
            ].includes(codec),
        ) ?? [];
  } catch {
    /* Unsupported browser API. */
  }
  let disposed = false;
  let runtimeKey = "";
  let runtimePending: Promise<void> | undefined;
  let runtimeLoaded = false;
  const [captureSupported, setCaptureSupported] =
    createSignal(false);
  let backendsPending: Promise<void> | undefined;
  let nativeReady = false;
  let audioPending: Promise<void> | undefined;
  let audioDirty = false;
  let nativeGeneration = 0;
  const patchNative = (
    patch: Partial<NativeMediaCapabilitiesSnapshot>,
  ) => {
    if (!disposed)
      setNative((current) =>
        current ? { ...current, ...patch } : current,
      );
  };

  const refreshAudioFormats = (): Promise<void> => {
    if (disposed || !nativeReady) return Promise.resolve();
    if (audioPending) {
      audioDirty = true;
      return audioPending;
    }
    setAudioFormatsLoading(true);
    setAudioFormatsFailed(false);
    const generation = nativeGeneration;
    audioPending = Promise.resolve()
      .then(() => {
        if (!runtime.screenShare?.audioFormats)
          throw new Error(
            "Audio format discovery is unavailable",
          );
        return runtime.screenShare.audioFormats();
      })
      .then((formats) => {
        if (!disposed && generation === nativeGeneration)
          setAudioFormats(formats);
      })
      .catch(() => {
        if (!disposed && generation === nativeGeneration) {
          setAudioFormats(undefined);
          setAudioFormatsFailed(true);
        }
      })
      .finally(() => {
        audioPending = undefined;
        if (!disposed && generation === nativeGeneration)
          setAudioFormatsLoading(false);
        if (audioDirty && !disposed) {
          audioDirty = false;
          void refreshAudioFormats();
        }
      });
    return audioPending;
  };

  const refreshAudioCodecs = () => {
    const generation = nativeGeneration;
    setAudioCodecsLoading(true);
    audioCodecsFailed = false;
    void runtime
      .screenShare!.codecs("audio")
      .then((codecs) => {
        if (!disposed && generation === nativeGeneration)
          setAudioCodecs(codecs);
      })
      .catch(() => {
        if (!disposed && generation === nativeGeneration) {
          setAudioCodecs([]);
          audioCodecsFailed = true;
        }
      })
      .finally(() => {
        if (!disposed && generation === nativeGeneration)
          setAudioCodecsLoading(false);
      });
  };
  const discoverNative = () => {
    const share = runtime.screenShare;
    const capture = runtime.capture;
    if (!share || !capture || !nativeReady) return;
    const generation = nativeGeneration;
    const current = () =>
      !disposed && generation === nativeGeneration;
    patchNative({
      encodingLoading: true,
      backendsLoading: true,
      failed: false,
      backendsFailed: false,
    });
    void share
      .encoders()
      .then((encoders) => {
        if (current())
          patchNative({
            encoders,
            codecs: [
              ...new Set(
                encoders.flatMap(
                  (encoder) => encoder.codecs,
                ),
              ),
            ].sort(),
            encodingLoading: false,
          });
      })
      .catch(() => {
        if (current())
          patchNative({
            failed: true,
            encodingLoading: false,
          });
      });
    backendsPending = capture
      .backends()
      .then((backends) => {
        if (current())
          patchNative({ backends, backendsLoading: false });
      })
      .catch(() => {
        if (current())
          patchNative({
            backendsFailed: true,
            backendsLoading: false,
          });
      });
    refreshAudioCodecs();
    void refreshAudioFormats();
  };

  const refresh = (force = false): Promise<void> => {
    if (disposed || runtime.kind !== "desktop")
      return Promise.resolve();
    if (runtimePending) return runtimePending;
    runtimePending = runtime
      .getCapabilities()
      .then((capabilities) => {
        if (disposed) return;
        const desktop = capabilities.runtime === "desktop";
        runtimeLoaded = true;
        setCaptureSupported(
          desktop &&
            capabilities.nativeScreenCapture &&
            !!runtime.capture,
        );
        setFrameRates(
          desktop
            ? displayVideoFrameRates(
                capabilities.displayRefreshRates,
              )
            : defaultVideoFrameRates,
        );
        const supported =
          desktop &&
          capabilities.nativeScreenCapture &&
          !!runtime.screenShare &&
          !!runtime.capture;
        const key = String(supported);
        const changed = key !== runtimeKey;
        runtimeKey = key;
        nativeReady = supported;
        if (!supported) {
          ++nativeGeneration;
          setNative(null);
          setAudioFormats(undefined);
          setAudioCodecs([]);
          setAudioCodecsLoading(false);
          setAudioFormatsLoading(false);
          setAudioFormatsFailed(false);
          return;
        }
        if (
          changed ||
          force ||
          native()?.failed ||
          native()?.backendsFailed
        ) {
          ++nativeGeneration;
          if (!native())
            setNative({
              codecs: [],
              encoders: [],
              backends: { screen: [], window: [] },
              failed: false,
            });
          discoverNative();
        } else {
          if (audioFormatsFailed())
            void refreshAudioFormats();
          if (audioCodecsFailed) refreshAudioCodecs();
        }
      })
      .catch(() => {
        if (!disposed) {
          setFrameRates(
            (current) => current ?? defaultVideoFrameRates,
          );
          if (!runtimeLoaded) {
            setNative(null);
            setAudioFormatsLoading(false);
            setAudioCodecsLoading(false);
          }
        }
      })
      .finally(() => {
        runtimePending = undefined;
      });
    return runtimePending;
  };

  createEffect(() => {
    revision();
    const stream = options.stream();
    const listeners = new AbortController();
    stream?.addEventListener?.("addtrack", refreshTracks, {
      signal: listeners.signal,
    });
    stream?.addEventListener?.(
      "removetrack",
      refreshTracks,
      { signal: listeners.signal },
    );
    for (const track of stream?.getAudioTracks() ?? [])
      track.addEventListener?.("ended", refreshTracks, {
        signal: listeners.signal,
      });
    onCleanup(() => listeners.abort());
  });
  const browserSampling = createMemo(() => {
    revision();
    const denied =
      options.permissions.state("audioinput") === "denied";
    const tracks = options.stream()?.getAudioTracks() ?? [];
    return browserAudioSampling(
      denied ? [] : options.permissions.devices(),
      denied
        ? tracks.filter(
            (track) => track.contentHint === "music",
          )
        : tracks,
      microphoneId(),
    );
  });
  let deviceKey: string | undefined;
  createEffect(() => {
    const next = JSON.stringify(
      options.permissions
        .devices()
        .filter((device) => device.kind !== "videoinput")
        .map((device) => [
          device.kind,
          device.deviceId,
          device.groupId,
        ])
        .sort(),
    );
    const changed =
      deviceKey !== undefined && deviceKey !== next;
    deviceKey = next;
    if (changed)
      untrack(() => {
        void refreshAudioFormats();
      });
  });
  onMount(() => {
    void refresh();
    const listener = new AbortController();
    window.addEventListener(
      "focus",
      () => {
        void refresh();
      },
      { signal: listener.signal },
    );
    onCleanup(() => listener.abort());
  });
  onCleanup(() => {
    disposed = true;
    ++nativeGeneration;
  });
  // Consumers await the initial discovery, but opening a view never invalidates it.
  const ready = () =>
    runtimeLoaded
      ? Promise.resolve()
      : (runtimePending ?? refresh());
  const captureBackends =
    async (): Promise<CaptureCapabilities> => {
      await ready();
      await backendsPending;
      const snapshot = native();
      if (!snapshot || snapshot.backendsFailed)
        throw new Error("Capture capabilities unavailable");
      return snapshot.backends;
    };
  return {
    native,
    frameRates,
    audioCodecs,
    audioCodecsLoading,
    audioFormats,
    audioFormatsLoading,
    audioFormatsFailed,
    browserSampling,
    browserAudioCodecs: () => browserCodecs,
    browserVideoCodecs: () => videoCodecs,
    setMicrophoneId,
    refresh,
    ready,
    captureSupported,
    captureBackends,
  };
}

export type AppMediaCapabilities = ReturnType<
  typeof createAppMediaCapabilities
>;
