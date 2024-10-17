/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/info" />
/// <reference types="vite-plugin-pwa/solid" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN: string;
  readonly VITE_FIREBASE_PROJECT_ID: string;
  readonly VITE_FIREBASE_SOTRAGE_BUCKET: string;
  readonly VITE_FIREBASE_MESSAGEING_SENDER_ID: string;
  readonly VITE_FIREBASE_APP_ID: string;
  readonly VITE_FIREBASE_MEASUREMENT_ID: string;
  readonly VITE_FIREBASE_DATABASE_URL: string;
  readonly VITE_WEBSOCKET_URL: string;

  readonly VITE_BACKEND: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// 添加这个全局变量声明
declare const __APP_VERSION__: string;
declare const __APP_LICENSE__: string;


declare module "virtual:pwa-register/solid" {
  import type { Accessor, Setter } from "solid-js";
  import type { RegisterSWOptions } from "vite-plugin-pwa/types";

  export function useRegisterSW(
    options?: RegisterSWOptions,
  ): {
    needRefresh: [Accessor<boolean>, Setter<boolean>];
    offlineReady: [Accessor<boolean>, Setter<boolean>];
    updateServiceWorker: (
      reloadPage?: boolean,
    ) => Promise<void>;
  };
}
