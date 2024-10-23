import { makePersisted } from "@solid-primitives/storage";
import { createStore } from "solid-js/store";
import { FileID } from "./libs/core/type";
import { createEffect, createSignal } from "solid-js";
import { cacheManager } from "./libs/services/cache-serivce";

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

// App options
export type AppOption = {
  // Receiver
  maxMomeryCacheSlices: number;

  // Sender
  channelsNumber: number;
  chunkSize: number;
  ordered: boolean;
  bufferedAmountLowThreshold: number;
  compressionLevel: CompressionLevel;
  blockSize: number;

  // Stream
  videoMaxBitrate: number;
  audioMaxBitrate: number;

  // Connection
  servers: ConnectionOptions;
  shareServersWithOthers: boolean;

  // Appearance
  locale: Locale;
  showAboutDialog: boolean;
  backgroundImage?: FileID;
  backgroundImageOpacity: number;
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
    showAboutDialog: true,
    shareServersWithOthers: false,
    backgroundImageOpacity: 0.5,
  } satisfies AppOption;
};

export const [appOptions, setAppOptions] = makePersisted(
  createStore<AppOption>(getDefaultAppOptions()),
  {
    name: "app_options",
    storage: localStorage,
  },
);

export const [backgroundImage, setBackgroundImage] =
  createSignal<string | undefined>(undefined);

createEffect(async () => {
  if (!appOptions.backgroundImage) {
    setBackgroundImage(undefined);
    return;
  }
  if (cacheManager.status() === "loading") {
    return;
  }
  const backgroundImage =
    cacheManager.caches[appOptions.backgroundImage];
  if (!backgroundImage) return;
  const file = await backgroundImage.getFile();
  if (!file) return;
  const url = URL.createObjectURL(file);
  setBackgroundImage(url);
});
