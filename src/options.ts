import { makePersisted } from "@solid-primitives/storage";
import { createStore } from "solid-js/store";

export type Locale = "en" | "zh";

export type TurnServerOptions = {
  url: string;
  username: string;
  password: string;
  authMethod: string;
};

type ConnectionOptions = {
  stuns: string[];
  turns?: TurnServerOptions[];
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
  channelsNumber: number;
  chunkSize: number;
  ordered: boolean;
  bufferedAmountLowThreshold: number;
  maxMomeryCacheSlices: number;
  videoMaxBitrate: number;
  audioMaxBitrate: number;
  compressionLevel: CompressionLevel;
  blockSize: number;
  servers: ConnectionOptions;
  locale: Locale;
};

export const getDefaultAppOptions = () => {
  return {
    channelsNumber: 2,
    chunkSize: 1024 * 1024,
    blockSize: 64 * 1024,
    ordered: false,
    bufferedAmountLowThreshold: 512 * 1024,
    maxMomeryCacheSlices: 12,
    videoMaxBitrate: 128 * 1024 * 1024,
    audioMaxBitrate: 512 * 1024,
    servers: {
      stuns: ["stun:stun.l.google.com:19302"],
    },
    compressionLevel: 0,
    locale: navigator.language.startsWith("zh")
      ? "zh"
      : "en",
  } satisfies AppOption;
};

export const [appOptions, setAppOptions] = makePersisted(
  createStore<AppOption>(getDefaultAppOptions()),
  {
    name: "app_options",
    storage: localStorage,
  },
);
