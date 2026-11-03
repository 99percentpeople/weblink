import { browserNotifications } from "./browser-notifications";
import {
  browserRoomTransport,
  type PlatformRuntime,
} from "@weblink/platform";

export const platform: PlatformRuntime = {
  getRoomTransport: () => browserRoomTransport,
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
