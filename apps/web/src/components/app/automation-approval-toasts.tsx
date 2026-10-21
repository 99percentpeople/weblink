import { sessionService } from "@/libs/application/session-service";
import { createEffect, onCleanup } from "solid-js";
import { toast } from "solid-sonner";
import { useAppState } from "@/libs/state/app-state-context";
import { requestClientInfoDialog } from "@/components/dialogs/client-info-dialog-events";
import { scopeLabel } from "@/libs/i18n/automation";
import { t } from "@/i18n";

/** A notification only opens the authoritative review UI; it never grants access. */
export function AutomationApprovalToasts() {
  const { automation } = useAppState();
  const visible = new Map<string, string | number>();
  createEffect(() => {
    const pending = (
      automation?.snapshot().pending ?? []
    ).filter(
      (request) => request.principal.kind === "peer",
    );
    const ids = new Set(
      pending.map((request) => request.id),
    );
    for (const [id, toastId] of visible) {
      if (!ids.has(id)) {
        toast.dismiss(toastId);
        visible.delete(id);
      }
    }
    for (const request of pending) {
      if (visible.has(request.id)) continue;
      visible.set(
        request.id,
        toast(t("automation.requests"), {
          id: `automation-approval:${request.id}`,
          duration: Infinity,
          description: `${request.principal.label} · ${scopeLabel(request.scope)}`,
          action: {
            label: t("automation.review_request"),
            onClick: () => {
              const current = automation
                ?.snapshot()
                .pending.find(
                  (item) => item.id === request.id,
                );
              if (
                !current ||
                current.expiresAt <= Date.now()
              )
                return;
              if (current.principal.kind === "peer") {
                const peerId = current.principal.id;
                if (sessionService.canReceive(peerId))
                  requestClientInfoDialog(
                    peerId,
                    "settings",
                  );
              }
            },
          },
        }),
      );
    }
  });
  onCleanup(() => {
    for (const id of visible.values()) toast.dismiss(id);
    visible.clear();
  });
  return null;
}
