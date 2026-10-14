import {
  createEffect,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import type { AppUpdates } from "@/libs/state/create-app-updates";
import type { NotificationService } from "@/libs/application/notifications/notification-service";

export function createUpdateFeedback(options: {
  updates: AppUpdates;
  enabled: Accessor<boolean>;
  ready: Accessor<boolean>;
  notifications: NotificationService;
  openUpdates(): void;
}) {
  const { updates } = options;
  const notified = new Set<string>();
  let notificationId: string | undefined;
  let disposed = false;
  const dismiss = () => {
    if (!notificationId) return;
    options.notifications.dismiss(notificationId);
    notificationId = undefined;
  };
  createEffect(() => {
    if (options.ready()) {
      untrack(
        () => void updates.checkOnStartup(options.enabled),
      );
    }
  });
  createEffect(() => {
    const available = updates.startupUpdate();
    const current = () =>
      !disposed &&
      options.enabled() &&
      updates.pending() !== "install" &&
      updates.update()?.version === available?.version;
    if (!available || !current()) {
      untrack(dismiss);
      return;
    }
    if (notified.has(available.version)) return;
    notified.add(available.version);
    untrack(() => {
      dismiss();
      const id = `desktop-update:${available.version}`;
      notificationId = id;
      const title = t("setting.updates.available", {
        version: available.version,
      });
      const open = () => {
        if (current()) options.openUpdates();
      };
      void options.notifications.show({
        category: "updates",
        current,
        present() {
          toast.info(title, {
            id,
            duration: 10_000,
            action: {
              label: t("setting.updates.view"),
              onClick: open,
            },
          });
          return { dismiss: () => toast.dismiss(id) };
        },
        notification: {
          id,
          title,
          body: t("setting.updates.notification_body"),
          expiresAt: Date.now() + 24 * 60 * 60_000,
        },
        async respond() {
          open();
        },
      });
    });
  });
  onCleanup(() => {
    disposed = true;
    dismiss();
  });
}
