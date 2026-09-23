import { Navigate, useLocation } from "@solidjs/router";
import { Show } from "solid-js";
import { appState } from "@/libs/state/app-state";
import { legacyHomeHref } from "@/libs/application/home-navigation";

export default function LegacyHome() {
  const location = useLocation();
  return (
    <Show when={appState.profile.clientId}>
      <Navigate
        href={legacyHomeHref(
          location,
          appState.profile.clientId,
        )}
      />
    </Show>
  );
}
