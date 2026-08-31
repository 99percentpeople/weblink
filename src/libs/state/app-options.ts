import type { ClientID, FileID } from "@/libs/core/type";
import languages from "@/assets/i18n/languages.json";

export type Locale = string;

export type TurnServerOptions = {
  url: string;
  username: string;
  password: string;
  authMethod: string;
};

type ConnectionOptions = {
  stuns: string[];
  turns: TurnServerOptions[];
};

export type CompressionLevel =
  | 0
  | 1
  | 2
  | 3
  | 4
  | 5
  | 6
  | 7
  | 8
  | 9;

export type AppOption = {
  // Receiver
  maxMomeryCacheSlices: number;
  automaticDownload: boolean;

  // Sender
  enableClipboard: boolean;
  automaticCacheDeletion: boolean;
  channelsNumber: number;
  chunkSize: number;
  ordered: boolean;
  bufferedAmountLowThreshold: number;
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
  backgroundImageOpacity: number;
  redirectToClient?: ClientID;

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

export const getDefaultAppOptions = () => {
  const hasNavigator = typeof navigator !== "undefined";
  return {
    channelsNumber: 1,
    chunkSize: 512 * 1024,
    blockSize: 32 * 1024,
    ordered: false,
    enableClipboard:
      hasNavigator && navigator.clipboard !== undefined,
    automaticCacheDeletion: false,
    bufferedAmountLowThreshold: 32 * 1024,
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
    compressionLevel: 6,
    locale: hasNavigator
      ? localFromLanguage(navigator.language)
      : "en-us",
    shareServersWithOthers: true,
    backgroundImageOpacity: 0.5,
    automaticDownload: false,
    // todo: add dialog to prompt user the file size
    maxFileSize: 1024 * 1024 * 1024, // 1GB
    degradationPreference: "balanced",
    preferredVideoCodec: null,
    preferredAudioCodec: null,
  } satisfies AppOption;
};
