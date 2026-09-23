import { makePersisted } from "@solid-primitives/storage";
import {
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { reconcile } from "solid-js/store";
import type { SetStoreFunction } from "solid-js/store";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { STORAGE_KEYS } from "@/constants";
import type {
  AppOption,
  ClientConfig,
  RoomConfig,
} from "@/libs/state/app-options";
import {
  defaultClientConfig,
  getDefaultAppOptions,
  parseTurnServers,
  resolveClientConfig,
  resolveRoomConfig,
} from "@/libs/state/app-options";

export type {
  AppOption,
  ClientConfig,
  CompressionLevel,
  Locale,
  TurnServerOptions,
} from "@/libs/state/app-options";
export {
  defaultClientConfig,
  getDefaultAppOptions,
  localFromLanguage,
  localeOptionsMap,
  parseTurnServers,
  resolveClientConfig,
  stringifyTurnServers,
} from "@/libs/state/app-options";

export const [appInitialized, setAppInitialized] =
  makePersisted(createSignal(false), {
    name: STORAGE_KEYS.appInitialized,
    storage: localStorage,
  });

export const [starterMessageSent, setStarterMessageSent] =
  makePersisted(createSignal(false), {
    name: STORAGE_KEYS.starterMessageSent,
    storage: localStorage,
  });

let optionsInitialized = false;

export function initializeAppOptions() {
  if (optionsInitialized) return;
  optionsInitialized = true;

  const defaults = getDefaultAppOptions();

  const loadFromLocalStorage = () => {
    if (typeof localStorage === "undefined") {
      return defaults;
    }

    const raw = localStorage.getItem(
      STORAGE_KEYS.appOptions,
    );
    if (!raw) return defaults;

    try {
      const parsedValue = JSON.parse(
        raw,
      ) as Partial<AppOption> & {
        channelsNumber?: unknown;
      };
      const {
        channelsNumber: _legacyChannelsNumber,
        ...parsed
      } = parsedValue;
      const legacyBufferedAmount =
        parsed.bufferedAmountHighWaterMark === undefined
          ? parsed.bufferedAmountLowThreshold
          : undefined;

      return {
        ...defaults,
        ...parsed,
        bufferedAmountLowThreshold:
          legacyBufferedAmount !== undefined
            ? defaults.bufferedAmountLowThreshold
            : (parsed.bufferedAmountLowThreshold ??
              defaults.bufferedAmountLowThreshold),
        bufferedAmountHighWaterMark:
          legacyBufferedAmount !== undefined
            ? Math.max(
                defaults.bufferedAmountHighWaterMark,
                legacyBufferedAmount,
              )
            : (parsed.bufferedAmountHighWaterMark ??
              defaults.bufferedAmountHighWaterMark),
        servers: {
          ...defaults.servers,
          ...(parsed.servers ?? {}),
        },
      } satisfies AppOption;
    } catch (err) {
      console.warn(
        "[initializeAppOptions] invalid app_options in localStorage",
        err,
      );
      return defaults;
    }
  };

  setAppState("options", reconcile(loadFromLocalStorage()));

  createEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      STORAGE_KEYS.appOptions,
      JSON.stringify(appState.options),
    );
  });
}

export const appOptions = appState.options;

export const setAppOptions: SetStoreFunction<AppOption> = ((
  ...args: any[]
) => (setAppState as any)("options", ...args)) as any;

export const getClientConfig = (
  clientId: string,
): ClientConfig =>
  resolveClientConfig(appState.options, clientId);

export const setClientConfig = (
  clientId: string,
  patch: Partial<ClientConfig>,
) => {
  setAppOptions("clientConfigs", clientId, {
    ...getClientConfig(clientId),
    ...patch,
  });
};

export const setRoomConfig = (
  conversationId: string,
  patch: Partial<RoomConfig>,
) => {
  setAppOptions("roomConfigs", conversationId, {
    ...resolveRoomConfig(appState.options, conversationId),
    ...patch,
  });
};

export const [backgroundImage, setBackgroundImage] =
  createSignal<string | undefined>(undefined);

createEffect(() => {
  const fileId = appState.options.backgroundImage;
  setBackgroundImage(undefined);
  if (!fileId) {
    return;
  }
  if (appState.cache.status === "loading") {
    return;
  }
  const cache = appState.cache.caches[fileId];
  if (!cache) return;

  let cancelled = false;
  let url: string | null = null;

  cache
    .getFile()
    .then((file) => {
      if (cancelled || !file) return;
      url = URL.createObjectURL(file);
      setBackgroundImage(url);
    })
    .catch((error) => {
      if (!cancelled)
        console.warn(
          "Unable to load background image",
          error,
        );
    });

  onCleanup(() => {
    cancelled = true;
    if (url) URL.revokeObjectURL(url);
  });
});

createEffect(() => {
  if (
    import.meta.env.VITE_STUN_SERVERS &&
    appState.options.servers.stuns.length === 0
  ) {
    const servers = import.meta.env.VITE_STUN_SERVERS.split(
      ",",
    );
    setAppOptions("servers", "stuns", servers);
  }
});

createEffect(() => {
  if (
    import.meta.env.VITE_TURN_SERVERS &&
    appState.options.servers.turns.length === 0
  ) {
    const serverValue =
      import.meta.env.VITE_TURN_SERVERS.split(",").join(
        "\n",
      );
    const servers = parseTurnServers(serverValue);
    setAppOptions("servers", "turns", servers);
  }
});

createEffect(() => {
  document
    .querySelector("html")
    ?.setAttribute("lang", appState.options.locale);
});
