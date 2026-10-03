import type { Accessor } from "solid-js";
import type { PlatformRuntime } from "@weblink/platform";
import type { AppPermissions } from "./create-app-permissions";
import { createAppMediaCapabilities } from "./create-app-media-capabilities";
import { createAppStartup } from "./create-app-startup";
import { createAppCaptureSources } from "./create-app-capture-sources";

export function createAppSettings(options: {
  platform: PlatformRuntime;
  permissions: Pick<
    AppPermissions["media"],
    "devices" | "state"
  >;
  stream: Accessor<MediaStream | null>;
}) {
  const mediaCapabilities =
    createAppMediaCapabilities(options);
  return {
    mediaCapabilities,
    runtimeCapabilities:
      mediaCapabilities.runtimeCapabilities,
    startup: createAppStartup(
      options.platform.application?.autostart,
    ),
    captureSources: createAppCaptureSources({
      capture: options.platform.capture,
      supported: mediaCapabilities.captureSupported,
    }),
  };
}
