import { For, Show, useContext } from "solid-js";
import {
  permissionGroupIds,
  groupDecision,
  setGroupDecision,
  type AutomationDecision,
} from "@weblink/automation";
import { AppStateContext } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import { setClientConfig } from "@/libs/state/permission-options";
import { SettingGroup } from "./setting-layout";
import { PermissionSelect } from "./permission-select";
import AutomationPermissions from "./automation-permissions";
import {
  groupLabel,
  groupDescription,
} from "@/libs/i18n/automation";
import { t } from "@/i18n";

export default function ClientAutomationPermissions(props: {
  clientId: string;
  trusted: boolean;
}) {
  const runtime = useContext(AppStateContext)?.automation;
  const policy = () =>
    appState.options.clientConfigs[props.clientId]
      ?.automation;
  return (
    <Show when={runtime?.desktop && runtime}>
      {(automation) => (
        <>
          <SettingGroup
            title={t("automation.title")}
            description={t(
              "automation.device_permissions_description",
            )}
          >
            <Show
              when={
                automation().enabled() &&
                automation().snapshot().policiesSuspended
              }
            >
              <p
                role="status"
                class="text-muted-foreground text-sm"
              >
                {t("automation.policies_paused")}
              </p>
            </Show>
            <For each={permissionGroupIds}>
              {(group) => (
                <PermissionSelect<AutomationDecision>
                  label={groupLabel(group)}
                  description={groupDescription(group)}
                  disabled={!props.trusted}
                  options={["ask", "allow", "deny"]}
                  value={
                    props.trusted
                      ? groupDecision(policy(), group)
                      : "deny"
                  }
                  placeholder={t(
                    "automation.mixed_permissions",
                  )}
                  optionLabel={(decision) =>
                    decision === "allow"
                      ? t(
                          "setting.permissions.allow_permanently",
                        )
                      : t(`setting.permissions.${decision}`)
                  }
                  onChange={(decision) => {
                    if (props.trusted)
                      setClientConfig(props.clientId, {
                        automation: setGroupDecision(
                          policy(),
                          group,
                          decision,
                        ),
                      });
                  }}
                />
              )}
            </For>
          </SettingGroup>
          <Show
            when={props.trusted && automation().enabled()}
          >
            <AutomationPermissions
              runtime={automation()}
              peerId={props.clientId}
            />
          </Show>
        </>
      )}
    </Show>
  );
}
