export const APP_NAME = "Weblink";

export const STORAGE_KEYS = {
  appInitialized: "app_initialized",
  starterMessageSent: "starter_message_sent",
  appOptions: "app_options",
  profile: "profile",
} as const;

export const MOBILE_BREAKPOINT_PX = 768;

export const MAX_SHARE_FILE_SIZE_BYTES = 50 * 1024 * 1024;

export const FILE_PREFIX = "file-" as const;
export const TRANSFER_CHANNEL_PREFIX = FILE_PREFIX;
export const DBNAME_PREFIX = FILE_PREFIX;

export const MIN_IOS_VERSION = "16.0.0";
export const MIN_VERSIONS: Record<string, string> = {
  Chrome: "66.0.0",
  Firefox: "63.0.0",
  Safari: "16.0.0",
  Edge: "79.0.0",
  Opera: "53.0.0",
  "Chrome iOS": "16.0.0",
  "Firefox iOS": "16.0.0",
  "Edge iOS": "16.0.0",
  "Opera iOS": "16.0.0",
};

export const SIGNALING_CONNECTION_TIMEOUT_MS = 15_000;

export const PEER_SESSION_CONNECTION_TIMEOUT_MS = 10_000;
export const PEER_SESSION_DISCONNECTED_GRACE_MS = 2_500;
export const PEER_SESSION_AUTO_RECONNECT_MAX_ATTEMPTS = 10;
export const PEER_SESSION_AUTO_RECONNECT_MAX_DELAY_MS = 15_000;
