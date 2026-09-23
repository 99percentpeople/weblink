import type {
  IceServerOptions,
  TurnServerOptions,
} from "@/libs/domain/ice-server";
import type { CompressionLevel } from "@/libs/domain/transfer/options";
import type { ClientID, FileID } from "@/libs/domain/ids";
import languages from "@/assets/i18n/languages.json";
import type { WallpaperPresetId } from "@/libs/wallpapers";

export type Locale = string;
export type ConnectionOptions = IceServerOptions;
export type { TurnServerOptions, CompressionLevel };

export type ClientConfig = {
  /** Whether this peer may enumerate completed local cache entries. */
  provideFileList: boolean;
};

export const defaultClientConfig: ClientConfig = {
  provideFileList: true,
};

export type RoomConfig = {
  autoDownloadFiles: boolean;
  /** Maximum size in bytes, inclusive. */
  autoDownloadMaxSize: number;
};

export const defaultRoomConfig: RoomConfig = {
  autoDownloadFiles: false,
  autoDownloadMaxSize: 5 * 1024 * 1024,
};

export const resolveRoomConfig = (
  options: {
    roomConfigs: Record<string, RoomConfig | undefined>;
  },
  conversationId: string,
): RoomConfig => ({
  ...defaultRoomConfig,
  ...options.roomConfigs[conversationId],
});

export const resolveClientConfig = (
  options: {
    clientConfigs: Record<
      ClientID,
      ClientConfig | undefined
    >;
  },
  clientId: ClientID,
): ClientConfig => ({
  ...defaultClientConfig,
  ...(options.clientConfigs[clientId] ?? {}),
});

export type AppOption = {
  // Receiver
  maxMomeryCacheSlices: number;
  automaticDownload: boolean;

  // Sender
  enableClipboard: boolean;
  automaticCacheDeletion: boolean;
  chunkSize: number;
  ordered: boolean;
  bufferedAmountLowThreshold: number;
  bufferedAmountHighWaterMark: number;
  compressionLevel: CompressionLevel;
  blockSize: number;
  maxFileSize: number;

  // Connection
  servers: ConnectionOptions;
  shareServersWithOthers: boolean;
  relayOnly: boolean;

  // Appearance
  wakeLock: boolean;
  locale: Locale;
  backgroundImage?: FileID;
  backgroundPreset?: WallpaperPresetId;
  backgroundImageOpacity: number;
  redirectToClient?: ClientID;

  // Per-client privacy / behavior
  clientConfigs: Record<ClientID, ClientConfig | undefined>;

  // Local preferences keyed by the room's namespaced conversation identity.
  roomConfigs: Record<string, RoomConfig | undefined>;

  // Stream
  videoMaxBitrate: number;
  degradationPreference: RTCDegradationPreference;
  preferredVideoCodec: string | null;
  preferredAudioCodec: string | null;
};

export function parseTurnServers(
  input: string,
): TurnServerOptions[] {
  if (input.trim() === "") return [];

  return input
    .split("\n")
    .map((line, index) => {
      if (line.trim() === "") return null;
      const parts = line.split("|");
      if (parts.length !== 4)
        throw Error(
          `config error, line ${index + 1} should be 4 parts`,
        );
      const [url, username, password, authMethod] =
        parts.map((part) => part.trim());
      const validAuthMethods = [
        "longterm",
        "hmac",
        "cloudflare",
      ];
      if (!validAuthMethods.includes(authMethod)) {
        throw Error(
          `auth method error, line ${index + 1} given ${authMethod} expected ${validAuthMethods.join(
            " or ",
          )}`,
        );
      }
      return {
        url,
        username,
        password,
        authMethod,
      } satisfies TurnServerOptions;
    })
    .filter(
      (turn): turn is TurnServerOptions => turn !== null,
    );
}

export function stringifyTurnServers(
  turnServers: TurnServerOptions[],
): string {
  return turnServers
    .map((turn) => {
      return `${turn.url}|${turn.username}|${turn.password}|${turn.authMethod}`;
    })
    .join("\n");
}

export const signalingWebSocketUrl =
  import.meta.env.VITE_WEBSOCKET_URL ??
  (typeof window !== "undefined"
    ? (window as any).env?.VITE_WEBSOCKET_URL
    : undefined);

export const localeOptionsMap = languages as Record<
  Locale,
  string
>;

export function localFromLanguage(
  language: string | null | undefined,
): Locale {
  const normalized = language?.trim().toLowerCase();
  if (!normalized) return "en-us";
  return (
    Object.keys(localeOptionsMap).find((locale) =>
      locale.toLowerCase().includes(normalized),
    ) ?? "en-us"
  );
}

export const getDefaultAppOptions = (): AppOption => {
  const hasNavigator = typeof navigator !== "undefined";
  return {
    chunkSize: 512 * 1024,
    blockSize: 32 * 1024,
    ordered: false,
    enableClipboard:
      hasNavigator && navigator.clipboard !== undefined,
    automaticCacheDeletion: false,
    bufferedAmountLowThreshold: 64 * 1024,
    bufferedAmountHighWaterMark: 256 * 1024,
    maxMomeryCacheSlices: 12,
    videoMaxBitrate: 25 * 1024 * 1024,
    servers: {
      stuns:
        import.meta.env.VITE_STUN_SERVERS?.split(",") ?? [],
      turns: parseTurnServers(
        import.meta.env.VITE_TURN_SERVERS ?? "",
      ),
    },
    relayOnly: false,
    wakeLock: true,
    compressionLevel: 0,
    locale: hasNavigator
      ? localFromLanguage(navigator.language)
      : "en-us",
    shareServersWithOthers: true,
    backgroundImageOpacity: 0.5,
    automaticDownload: false,
    clientConfigs: {},
    roomConfigs: {},
    // todo: add dialog to prompt user the file size
    maxFileSize: 1024 * 1024 * 1024, // 1GB
    degradationPreference: "balanced",
    preferredVideoCodec: null,
    preferredAudioCodec: null,
  } satisfies AppOption;
};
