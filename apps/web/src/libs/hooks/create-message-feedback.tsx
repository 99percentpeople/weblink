import {
  createEffect,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import type {
  NotificationIntent,
  NotificationService,
} from "@/libs/application/notifications/notification-service";
import type { NotificationOptions } from "@/libs/domain/notification-options";

/** Visible messages use in-app feedback, independent of system notification permission. */
export function createMessageFeedback(options: {
  preferences: Accessor<NotificationOptions>;
  visible: Accessor<boolean>;
  notifications?: Pick<NotificationService, "show">;
}) {
  const visible = options.visible;
  const [notices, setNotices] = createSignal<
    NotificationIntent[]
  >([]);
  let disposed = false;
  const current = (intent: NotificationIntent) =>
    !disposed &&
    options.preferences().enabled &&
    options.preferences().messages &&
    intent.current() &&
    intent.notification.expiresAt > Date.now();
  const forget = (intent: NotificationIntent) =>
    setNotices((items) =>
      items.filter((item) => item !== intent),
    );
  const dismiss = (intent: NotificationIntent) => {
    forget(intent);
    toast.dismiss(intent.notification.id);
  };
  createEffect(() => {
    const shown = visible();
    for (const intent of notices())
      if (!shown || !current(intent))
        untrack(() => dismiss(intent));
  });
  onCleanup(() => {
    disposed = true;
    for (const intent of notices())
      toast.dismiss(intent.notification.id);
  });

  return async (
    intent: Omit<NotificationIntent, "category">,
  ): Promise<void> => {
    const message: NotificationIntent = {
      ...intent,
      category: "messages",
    };
    if (!current(message)) return;
    if (!visible()) {
      await options.notifications?.show({
        ...message,
        // Recheck after permissions, avatars and asynchronous native display.
        canDisplay: () =>
          !disposed &&
          !visible() &&
          (intent.canDisplay?.() ?? true),
      });
      return;
    }
    const id = message.notification.id;
    if (
      notices().some((item) => item.notification.id === id)
    )
      return;
    if (notices().length >= 64) dismiss(notices()[0]);
    setNotices((items) => [...items, message]);
    toast.info(message.notification.title, {
      id,
      duration: 5000,
      description: () => (
        <span class="line-clamp-3 whitespace-pre-wrap break-words">
          {message.notification.body}
        </span>
      ),
      action: {
        label: t("setting.notifications.open"),
        onClick: () => {
          const live =
            notices().includes(message) && current(message);
          dismiss(message);
          if (live)
            void message
              .respond({ id, action: "open" })
              .catch((error) => {
                console.warn(
                  "Could not open message notification",
                  error,
                );
              });
        },
      },
      onDismiss: () => forget(message),
      onAutoClose: () => forget(message),
    });
  };
}
