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
  getCapabilities(): Promise<RuntimeCapabilities>;
  initialize(): () => void;
}

/** Only explicit web links may be passed to the system browser. */
export function isExternalLink(url: URL): boolean {
  return (
    ["http:", "https:", "mailto:"].includes(url.protocol) &&
    !url.username &&
    !url.password
  );
}
