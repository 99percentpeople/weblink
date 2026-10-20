import { createEffect, onCleanup, untrack } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { sessionService } from "@/libs/application/session-service";

/** Approval is scoped to one pending request on the current peer connection. */
export function DevicePairingToasts() {
  const notices = new Map<string, string>();
  createEffect(() => {
    const clients = appState.session.clientViewData;
    for (const [peer, request] of notices) {
      const current = sessionService.trust.pairing(peer);
      if (
        !clients[peer]?.messageChannel ||
        current?.state !== "incoming" ||
        current.id !== request
      ) {
        toast.dismiss(`device-pairing:${request}`);
        notices.delete(peer);
      }
    }
    for (const client of Object.values(clients)) {
      const peer = client.clientId;
      const request = sessionService.trust.pairing(peer);
      if (
        !client.messageChannel ||
        request?.state !== "incoming" ||
        notices.has(peer)
      )
        continue;
      untrack(() => {
        notices.set(peer, request.id);
        const respond = (accept: boolean) => {
          const current =
            sessionService.trust.pairing(peer);
          if (
            notices.get(peer) === request.id &&
            appState.session.clientViewData[peer]
              ?.messageChannel &&
            current?.state === "incoming" &&
            current.id === request.id
          )
            sessionService.trust.respondPairing(
              peer,
              request.id,
              accept,
            );
        };
        toast(
          t("device_trust.pairing_request", {
            name: client.name,
          }),
          {
            id: `device-pairing:${request.id}`,
            duration: Infinity,
            description: t(
              "device_trust.confirm_description",
            ),
            action: {
              label: t("device_trust.accept"),
              onClick: () => respond(true),
            },
            cancel: {
              label: t("device_trust.reject"),
              onClick: () => respond(false),
            },
          },
        );
      });
    }
  });
  onCleanup(() => {
    for (const request of notices.values())
      toast.dismiss(`device-pairing:${request}`);
    notices.clear();
  });
  return null;
}
