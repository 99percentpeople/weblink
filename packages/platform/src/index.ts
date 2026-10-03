import type { SystemNotifications } from "./notifications";
export type * from "./notifications";

export interface RuntimeCapabilities {
  runtime: "browser" | "desktop";
  os: string;
  version: string | null;
  nativeScreenCapture: boolean;
  /** Current refresh rates of connected displays; empty when unavailable. */
  displayRefreshRates: number[];
  remoteInput: boolean;
  systemKeyboard?: boolean;
  /** True only after a recoverable native tray icon has been created. */
  systemTray?: boolean;
}

export interface PlatformRuntime {
  readonly notifications?: SystemNotifications;
  readonly pictureInPicture?: NativePictureInPicture;
  readonly application?: NativeApplication;
  readonly keyboard?: NativeKeyboard;
  readonly remoteControl?: NativeRemoteControl;
  readonly kind: "browser" | "desktop";
  /** Automatic mode is provided only by a host that grants local media requests. */
  readonly mediaPermissionPolicy?: "prompt" | "automatic";
  readonly supportsServiceWorker: boolean;
  readonly capture?: NativeCapture;
  readonly screenShare?: NativeScreenShare;
  getCapabilities(): Promise<RuntimeCapabilities>;
  initialize(): () => void;
}

export interface NativeApplicationOptions {
  closeBehavior: "ask" | "exit" | "tray";
  hideOnRemoteControl: boolean;
  locale: "en" | "zh-cn" | "zh-tw";
}

export interface NativeApplication {
  show(): Promise<void>;
  readonly autostart?: {
    enabled(): Promise<boolean>;
    setEnabled(enabled: boolean): Promise<boolean>;
    behavior(): Promise<"tray" | "window">;
    setBehavior(behavior: "tray" | "window"): Promise<void>;
  };
  configure(
    options: NativeApplicationOptions,
  ): Promise<void>;
  watchCloseRequests(
    onRequest: (request: NativeCloseRequest) => void,
  ): Promise<NativeCloseSession>;
}

export interface NativePipOptions {
  eligible: boolean;
  automatic: boolean;
  reducedMotion?: boolean;
}
export interface NativePipState {
  active: boolean;
  transitioning: boolean;
  /** Logical height replacing the native caption in the compact window. */
  titleBarHeight: number;
}
export interface NativePictureInPicture {
  watch(
    onState: (state: NativePipState) => void,
  ): Promise<NativePipSession>;
}
export interface NativePipSession {
  configure(options: NativePipOptions): Promise<void>;
  enter(): Promise<void>;
  exit(): Promise<void>;
  drag(): Promise<void>;
  close(): Promise<void>;
}

export interface NativeCloseRequest {
  id: string;
  trayAvailable: boolean;
}
export type NativeCloseResponse =
  | "cancel"
  | "tray"
  | "exit";
export interface NativeCloseSession {
  respond(
    requestId: string,
    response: NativeCloseResponse,
    remember: boolean,
  ): Promise<void>;
  close(): Promise<void>;
}

/** Controller-side physical input, scoped to the focused local control surface. */
export type NativeKeyboardEvent =
  | {
      type: "key";
      scanCode: number;
      extended: boolean;
      down: boolean;
      sequence: number;
      timestamp: number;
    }
  | {
      type: "stopped";
      reason:
        | "closed"
        | "focus"
        | "expired"
        | "overflow"
        | "exit"
        | "emergency";
    };
export interface NativeKeyboardSession {
  renew(sequence: number): Promise<void>;
  close(): Promise<void>;
}
export interface NativeKeyboard {
  supported(): Promise<boolean>;
  start(
    exitShortcut: "ctrl-alt-shift-q" | "ctrl-alt-shift-x",
    onEvent: (event: NativeKeyboardEvent) => void,
  ): Promise<NativeKeyboardSession>;
}

export interface CaptureSource {
  id: string;
  kind: "monitor" | "window";
  name: string;
  width: number;
  height: number;
}

/** Physical desktop pixels, including negative multi-monitor origins. */
export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface DisplayGeometry {
  sourceId: string;
  bounds: DisplayRect;
  /** Display orientation; bounds are already oriented. */
  rotation: 0 | 90 | 180 | 270;
  /** OS resource scale; never multiply physical coordinates by this value. */
  scalePercent: number | null;
}
export interface DisplayLayout {
  /** Opaque, service-local revision. A query failure invalidates its predecessor. */
  revision: string;
  virtualBounds: DisplayRect;
  displays: DisplayGeometry[];
}

export type CaptureBackend = "auto" | "wgc" | "dxgi";
export interface CaptureOptions {
  backend: CaptureBackend;
}
export interface CaptureBackendInfo {
  id: Exclude<CaptureBackend, "auto">;
  name: string;
}
export interface CaptureCapabilities {
  screen: CaptureBackendInfo[];
  window: CaptureBackendInfo[];
}
export interface NativeEncoder {
  id: string;
  name: string;
  hardware: boolean;
  codecs: string[];
}

export interface CaptureStatus {
  sessionId: string | null;
  source: CaptureSource | null;
  backend?: CaptureBackend | null;
  state:
    | "idle"
    | "running"
    | "stopped"
    | "closed"
    | "failed";
  frames: number;
  width: number;
  height: number;
  fps: number;
  elapsedMs: number;
  lastFrameAgeMs: number | null;
  stopReason:
    | "user"
    | "sourceClosed"
    | "clientDisconnected"
    | "shutdown"
    | null;
  error: string | null;
}

/** Source discovery and capture control. Streaming frames stay native. */
export interface NativeCapture {
  /** Read-only physical inventory; does not start capture or grant input. */
  displayLayout?(): Promise<DisplayLayout>;
  sources(): Promise<CaptureSource[]>;
  backends(): Promise<CaptureCapabilities>;
  /** One bounded PNG snapshot for the local picker; never starts a media share. */
  thumbnail(
    sourceId: string,
    options?: CaptureOptions,
  ): Promise<Blob>;
  start(
    sourceId: string,
    options?: CaptureOptions,
  ): Promise<CaptureStatus>;
  /** Renews the session lease; call regularly while owning a running capture. */
  status(sessionId: string): Promise<CaptureStatus>;
  stop(sessionId: string): Promise<CaptureStatus>;
}

/** Only explicit web links may be passed to the system browser. */
export function isExternalLink(url: URL): boolean {
  return (
    ["http:", "https:", "mailto:"].includes(url.protocol) &&
    !url.username &&
    !url.password
  );
}

export interface NativeScreenOptions {
  /** Capture system playback only after explicit picker consent. */
  audio?: boolean;
  /** Capture format; automatic defaults are 48 kHz and two channels. */
  audioSampleRate?: number;
  audioChannelCount?: 1 | 2;
  /** Preferred codec, retaining compatible alternatives during negotiation. */
  audioCodec?: string | null;
  maxWidth: number;
  maxHeight: number;
  frameRate: number;
  maxBitrate: number;
  codec: string | null;
  encoder?: string;
  degradationPreference: RTCDegradationPreference;
}

/** Validation ceiling, not a promise of capture/encoder throughput. */
export const MAX_NATIVE_FRAME_RATE = 1000;

/** Parameters that can change without recreating capture or WebRTC sessions. */
export type NativeVideoSettings = Pick<
  NativeScreenOptions,
  | "maxWidth"
  | "maxHeight"
  | "frameRate"
  | "maxBitrate"
  | "degradationPreference"
>;

/** Remote encoding stays native; local raw presentation has its own memory boundary. */
export interface NativeVideoStats {
  id: string;
  timestamp: number;
  codec: string;
  implementation: string;
  width: number;
  height: number;
  bytes: number;
  targetBitrate?: number;
  encoderBitrate?: number;
  availableOutgoingBitrate?: number;
  frames: number;
  encodeFrames: number;
  encodeSeconds: number;
  encoderQueueSeconds?: number;
  captureToEncodeSeconds?: number;
  freshFrames?: number;
  packetsSent?: number;
  sendDelaySeconds?: number;
  roundTripSeconds?: number;
}

export interface NativeScreenPreview {
  stream: MediaStream;
  close(): void;
  stats(): {
    id: string;
    timestamp: number;
    width: number;
    height: number;
    frames: number;
    implementation: string;
  };
}

/** Trusted local composition only. Never construct from remote signal payloads. */
export interface NativeControlContext {
  ownerId: string;
  peerGeneration: string;
  clientId: string;
  sourceId: string;
}
export interface NativeControlStatus {
  pending: {
    consentId: string;
    clientId: string;
    sourceId: string;
    peerGeneration?: string;
  } | null;
  clientId: string | null;
  closed: boolean;
}
export interface NativeRemoteControl {
  open(): Promise<string>;
  status(ownerId: string): Promise<NativeControlStatus>;
  end(ownerId: string): Promise<void>;
  revoke(ownerId: string): Promise<void>;
  approve(
    ownerId: string,
    consentId: string,
    approve: boolean,
  ): Promise<void>;
}

export interface AudioCaptureFormat {
  sampleRate: number;
  channelCount: 1 | 2;
}

export interface NativeScreenShare {
  /** Raw local presentation. Remote publication remains native WebRTC. */
  preview?(
    sessionId: string,
    audio: boolean,
    onEnded: () => void,
    signal?: AbortSignal,
  ): Promise<NativeScreenPreview>;
  stats?(
    sessionId: string,
    peerId: string,
  ): Promise<NativeVideoStats[]>;
  updateVideoSettings(
    sessionId: string,
    settings: NativeVideoSettings,
  ): Promise<void>;
  setAudioEnabled?(
    sessionId: string,
    enabled: boolean,
  ): Promise<void>;
  codecs(kind?: "audio" | "video"): Promise<string[]>;
  /** Probes supported capture formats without starting audio capture. */
  audioFormats?(): Promise<AudioCaptureFormat[]>;
  encoders(): Promise<NativeEncoder[]>;
  start(
    sourceId: string,
    options?: NativeScreenOptions,
    capture?: CaptureOptions,
  ): Promise<CaptureStatus>;
  offer(
    sessionId: string,
    peerId: string,
    iceServers: RTCIceServer[],
    relayOnly: boolean,
    preview?: boolean,
    onCandidate?: (candidate: RTCIceCandidateInit) => void,
    control?: NativeControlContext,
  ): Promise<string>;
  addIceCandidate(
    sessionId: string,
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void>;
  answer(
    sessionId: string,
    peerId: string,
    sdp: string,
  ): Promise<void>;
  closePeer(
    sessionId: string,
    peerId: string,
  ): Promise<void>;
}
