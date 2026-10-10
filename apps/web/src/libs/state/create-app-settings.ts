import type { Accessor } from "solid-js";
import type { PlatformRuntime } from "@weblink/platform";
import type { AppPermissions } from "./create-app-permissions";
import { createAppMediaCapabilities } from "./create-app-media-capabilities";
import { createAppStartup } from "./create-app-startup";
import { createAppCaptureSources } from "./create-app-capture-sources";
import { createAppClipboardAccess } from "./create-app-clipboard-access";
import { createAppInputDevices } from "./create-app-input-devices";
import { createAppLocalInput } from "./create-app-local-input";

export function createAppSettings(options: {
  platform: PlatformRuntime;
  permissions: Pick<
    AppPermissions["media"],
    "devices" | "state"
  >;
  stream: Accessor<MediaStream | null>;
}) {
  createAppLocalInput();
  const mediaCapabilities =
    createAppMediaCapabilities(options);
  createAppClipboardAccess({
    nativeClipboard: !!options.platform.clipboard,
    runtimeCapabilities:
      mediaCapabilities.runtimeCapabilities,
    runtimeReady: mediaCapabilities.ready,
  });
  return {
    inputDevices: createAppInputDevices(
      options.platform.remoteControl,
    ),
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
