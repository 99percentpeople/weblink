import type { PlatformRuntime } from "@weblink/platform";

export const platform: PlatformRuntime = {
  kind: "browser",
  supportsServiceWorker: true,
  getCapabilities: async () => ({
    runtime: "browser",
    os: "browser",
    version: null,
    nativeScreenCapture: false,
    displayRefreshRates: [],
    remoteInput: false,
  }),
  initialize: () => () => {},
};
