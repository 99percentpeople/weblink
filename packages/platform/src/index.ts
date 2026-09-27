export interface RuntimeCapabilities {
  runtime: "browser" | "desktop";
  os: string;
  version: string | null;
  nativeScreenCapture: boolean;
  remoteInput: boolean;
}

export interface PlatformRuntime {
  readonly kind: "browser" | "desktop";
  readonly supportsServiceWorker: boolean;
  readonly capture?: NativeCapture;
  getCapabilities(): Promise<RuntimeCapabilities>;
  initialize(): () => void;
}

export interface CaptureSource {
  id: string;
  kind: "monitor" | "window";
  name: string;
  width: number;
  height: number;
}

export interface CaptureStatus {
  sessionId: string | null;
  source: CaptureSource | null;
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

/** Diagnostics only. Frames remain native; this is not a WebRTC media track. */
export interface NativeCapture {
  sources(): Promise<CaptureSource[]>;
  start(sourceId: string): Promise<CaptureStatus>;
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
