import { onCleanup, type Accessor } from "solid-js";
import type {
  NotificationIntent,
  NotificationService,
} from "@/libs/application/notifications/notification-service";
import type { NotificationOptions } from "@/libs/domain/notification-options";

/** Only notify about chat messages while the application is hidden. */
export function createMessageFeedback(options: {
  preferences: Accessor<NotificationOptions>;
  visible: Accessor<boolean>;
  notifications?: Pick<NotificationService, "show">;
}) {
  const visible = options.visible;
  let disposed = false;
  const current = (intent: NotificationIntent) =>
    !disposed &&
    options.preferences().enabled &&
    options.preferences().messages &&
    intent.current() &&
    intent.notification.expiresAt > Date.now();
  onCleanup(() => {
    disposed = true;
  });

  return async (
    intent: Omit<NotificationIntent, "category">,
  ): Promise<void> => {
    const message: NotificationIntent = {
      ...intent,
      category: "messages",
    };
    if (visible() || !current(message)) return;
    await options.notifications?.show({
      ...message,
      // Recheck after permissions, avatars and asynchronous native display.
      canDisplay: () =>
        !disposed &&
        !visible() &&
        (intent.canDisplay?.() ?? true),
    });
  };
}
