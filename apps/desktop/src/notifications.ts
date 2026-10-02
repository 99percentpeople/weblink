import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NotificationAction,
  SystemNotifications,
} from "@weblink/platform";

export const nativeNotifications: SystemNotifications = {
  capabilities: () => invoke("notifications_capabilities"),
  requestPermission: () =>
    invoke("notifications_request_permission"),
  async watch(onAction) {
    const watchId = crypto.randomUUID();
    let closed = false;
    const events = new Channel<NotificationAction>(
      (action) => {
        if (!closed) onAction(action);
      },
    );
    try {
      await invoke("notifications_watch", {
        watchId,
        events,
      });
    } catch (error) {
      closed = true;
      await invoke("notifications_unwatch", {
        watchId,
      }).catch(() => {});
      throw error;
    }
    return {
      show: (notification) =>
        closed
          ? Promise.reject(
              new Error("Notification watcher ended"),
            )
          : invoke("notifications_show", {
              watchId,
              notification,
            }),
      dismiss: (id) =>
        closed
          ? Promise.resolve()
          : invoke("notifications_dismiss", {
              watchId,
              id,
            }),
      async close() {
        if (closed) return;
        closed = true;
        await invoke("notifications_unwatch", { watchId });
      },
    };
  },
};
