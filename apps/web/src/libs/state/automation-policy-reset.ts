import { batch } from "solid-js";
import { readAutomationPolicy } from "@weblink/automation";
import { STORAGE_KEYS } from "@/constants";
import { appState, setAppState } from "./app-state";

/** Native emergency stops apply to saved offline devices as well as live peers. */
export function resetAutomationPolicies(
  generation: string,
): void {
  if (
    !generation ||
    appState.options.automationPolicyGeneration ===
      generation
  )
    return;
  const clientConfigs = Object.fromEntries(
    Object.entries(appState.options.clientConfigs).map(
      ([id, config]) => [
        id,
        config
          ? {
              ...config,
              automation: Object.fromEntries(
                Object.entries(
                  readAutomationPolicy(config.automation),
                ).map(([scope, decision]) => [
                  scope,
                  decision === "allow" ? "ask" : decision,
                ]),
              ),
            }
          : undefined,
      ],
    ),
  );
  // Commit before another native policy write or page close. A failed storage
  // write leaves the generation unacknowledged, so stale allows stay fenced.
  localStorage.setItem(
    STORAGE_KEYS.appOptions,
    JSON.stringify({
      ...appState.options,
      clientConfigs,
      automationPolicyGeneration: generation,
    }),
  );
  batch(() => {
    setAppState("options", "clientConfigs", clientConfigs);
    setAppState(
      "options",
      "automationPolicyGeneration",
      generation,
    );
  });
}
