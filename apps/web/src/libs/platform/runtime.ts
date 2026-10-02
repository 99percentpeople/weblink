import { browserNotifications } from "./browser-notifications";
import type { PlatformRuntime } from "@weblink/platform";

export const platform: PlatformRuntime = {
  notifications: browserNotifications,
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
