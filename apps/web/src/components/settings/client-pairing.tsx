import { Show, createEffect, createSignal } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { sessionService } from "@/libs/application/session-service";
import { Button } from "@/components/ui/button";

export function ClientPairing(props: { clientId: string }) {
  const trust = () =>
    sessionService?.trust.get(props.clientId);
  const pairing = () =>
    sessionService?.trust.pairing(props.clientId);
  const client = () =>
    appState.session.clientViewData[props.clientId];
  const connected = () =>
    !!sessionService &&
    client()?.onlineStatus === "online" &&
    !!client()?.messageChannel;
  const status = () => {
    if (connected())
      return t(
        `device_trust.${trust()?.state ?? "verifying"}`,
      );
    const transport = client()?.onlineStatus ?? "offline";
    return t(
      `common.status.${transport === "online" ? "connecting" : transport}`,
    );
  };
  const [error, setError] = createSignal(false);
  createEffect(() => {
    props.clientId;
    pairing()?.id;
    setError(false);
  });
  const respond = (accept: boolean) => {
    const request = pairing();
    if (request)
      sessionService.trust.respondPairing(
        props.clientId,
        request.id,
        accept,
      );
  };
  return (
    <div class="space-y-2 text-sm">
      <p
        role="status"
        class={
          trust()?.state === "trusted"
            ? "text-sm"
            : "text-destructive text-sm"
        }
      >
        {status()}
      </p>
      <Show when={trust()?.state !== "trusted"}>
        <p class="text-muted-foreground text-sm">
          {t("device_trust.blocked_description")}
        </p>
      </Show>
      <Show
        when={
          pairing()?.state === "outgoing" ||
          pairing()?.state === "committing"
        }
      >
        <p role="status">
          {t(
            `device_trust.${pairing()?.state === "outgoing" ? "waiting_confirmation" : "saving_pairing"}`,
          )}
        </p>
      </Show>
      <Show when={pairing()?.state === "incoming"}>
        <p>{t("device_trust.incoming_request")}</p>
        <div class="setting-actions">
          <Button
            variant="outline"
            onClick={() => respond(false)}
          >
            {t("device_trust.reject")}
          </Button>
          <Button onClick={() => respond(true)}>
            {t("device_trust.accept")}
          </Button>
        </div>
      </Show>
      <Show when={pairing()?.state === "outgoing"}>
        <div class="setting-actions">
          <Button
            variant="outline"
            onClick={() => {
              const request = pairing();
              if (request)
                sessionService.trust.cancelPairing(
                  props.clientId,
                  request.id,
                );
            }}
          >
            {t("device_trust.cancel")}
          </Button>
        </div>
      </Show>
      <Show when={error() || pairing()?.state === "failed"}>
        <p role="alert" class="text-destructive">
          {t(
            `device_trust.failure.${error() ? "disconnected" : (pairing()?.reason ?? "invalid")}`,
          )}
        </p>
      </Show>
      <Show
        when={
          trust()?.state !== "trusted" &&
          (!pairing() || pairing()?.state === "failed")
        }
      >
        <div class="setting-actions">
          <Button
            disabled={!connected()}
            onClick={() => {
              setError(false);
              const peer = props.clientId;
              void sessionService.trust
                .requestPairing(peer)
                .catch(() => {
                  if (props.clientId === peer && !pairing())
                    setError(true);
                });
            }}
          >
            {t("device_trust.repair")}
          </Button>
        </div>
      </Show>
    </div>
  );
}
