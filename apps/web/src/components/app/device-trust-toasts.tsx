import { createEffect, onCleanup, untrack } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { requestClientInfoDialog } from "@/components/dialogs/client-info-dialog-events";

/** A warning only opens permission settings; pairing remains an explicit review. */
export function DeviceTrustToasts() {
  const notices = new Map<
    string,
    { toastId: string | number }
  >();
  const clients = () => appState.session.clientViewData;
  createEffect(() => {
    const connected = new Set(
      Object.values(clients())
        .filter((client) => client.messageChannel)
        .map((client) => client.clientId),
    );
    for (const [id, notice] of notices) {
      if (
        !connected.has(id) ||
        clients()[id]?.trust === "trusted"
      ) {
        toast.dismiss(notice.toastId);
        notices.delete(id);
      }
    }
    for (const id of connected) {
      const client = clients()[id];
      if (client.trust !== "untrusted" || notices.has(id))
        continue;
      untrack(() => {
        const notice = { toastId: `device-trust:${id}` };
        notices.set(id, notice);
        toast.warning(
          t("device_trust.connection_warning", {
            name: client.name,
          }),
          {
            id: notice.toastId,
            duration: Infinity,
            description: t(
              "device_trust.permissions_disabled",
            ),
            action: {
              label: t("device_trust.open_permissions"),
              onClick: () => {
                const current = clients()[id];
                if (
                  notices.get(id) !== notice ||
                  !current?.messageChannel ||
                  current.trust !== "untrusted"
                )
                  return;
                requestClientInfoDialog(id, "settings");
              },
            },
          },
        );
      });
    }
  });
  onCleanup(() => {
    for (const { toastId } of notices.values())
      toast.dismiss(toastId);
    notices.clear();
  });
  return null;
}
