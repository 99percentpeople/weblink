import type { PlatformRuntime } from "@weblink/platform";

export const platform: PlatformRuntime = {
  kind: "browser",
  supportsServiceWorker: true,
  getCapabilities: async () => ({
    runtime: "browser",
    os: "browser",
    version: null,
    nativeScreenCapture: false,
    remoteInput: false,
  }),
  initialize: () => () => {},
};
