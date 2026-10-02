import type { Accessor } from "solid-js";
import type { SystemNotifications } from "@weblink/platform";
import { createNotificationPermission } from "@/libs/hooks/notification-permission";
import { createMediaDevices } from "@/libs/hooks/media-devices";
import { createMediaDeviceAccess } from "@/libs/hooks/media-device-access";

export interface AppPermissions {
  notifications: ReturnType<
    typeof createNotificationPermission
  >;
  media: ReturnType<typeof createMediaDeviceAccess> & {
    refreshing: Accessor<boolean>;
    discoveryError: Accessor<Error | null>;
  };
}

/** AppState owns one set of permission signals and observers for all views. */
export function createAppPermissions(options: {
  notifications: SystemNotifications | undefined;
  outputSupported: Accessor<boolean>;
  mediaPermissionPolicy?: "prompt" | "automatic";
}): AppPermissions {
  const discovery = createMediaDevices();
  const media = createMediaDeviceAccess({
    devices: discovery.devices,
    refreshing: discovery.refreshing,
    refresh: discovery.updateDevices,
    outputSupported: options.outputSupported,
    permissionPolicy: options.mediaPermissionPolicy,
  });
  return {
    notifications: createNotificationPermission(
      options.notifications,
    ),
    media: {
      ...media,
      refreshing: discovery.refreshing,
      discoveryError: discovery.error,
    },
  };
}
