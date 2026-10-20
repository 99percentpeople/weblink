import ClientAutomationPermissions from "./client-automation-permissions";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { sessionService } from "@/libs/application/session-service";
import { setClientConfig } from "@/options";
import { PermissionSelect } from "./permission-select";
import {
  SettingBlock,
  SettingGroup,
  SettingSection,
} from "./setting-layout";
import { ClientPairing } from "./client-pairing";
export function ClientPermissions(props: {
  clientId: string;
}) {
  type Decision = "ask" | "allow" | "deny";
  const config = () =>
    appState.options.clientConfigs[props.clientId];
  const trust = () =>
    sessionService?.trust.get(props.clientId);
  const trusted = () => trust()?.state === "trusted";
  return (
    <SettingSection>
      <SettingGroup
        title={t("setting.permissions.groups.identity")}
      >
        <SettingBlock>
          <ClientPairing clientId={props.clientId} />
        </SettingBlock>
      </SettingGroup>
      <SettingGroup
        title={t("setting.permissions.groups.content")}
      >
        <PermissionSelect<"allowed" | "disallowed">
          label={t("device_trust.receive_content")}
          description={t(
            "device_trust.receive_description",
          )}
          disabled={!trusted()}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.receiveContent === true
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                receiveContent: decision === "allowed",
              });
          }}
        />
        <PermissionSelect<"allowed" | "disallowed">
          disabled={!trusted()}
          label={t("client.config.provide_file_list.title")}
          description={t(
            "client.config.provide_file_list.description",
          )}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.provideFileList !== false
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                provideFileList: decision === "allowed",
              });
          }}
        />
      </SettingGroup>
      <SettingGroup
        title={t("setting.permissions.groups.sharing")}
      >
        <PermissionSelect<"allowed" | "disallowed">
          label={t("device_trust.share_screen")}
          description={t("device_trust.share_description")}
          disabled={!trusted()}
          options={["allowed", "disallowed"]}
          value={
            trusted() && config()?.shareScreen === true
              ? "allowed"
              : "disallowed"
          }
          optionLabel={(decision) =>
            t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                shareScreen: decision === "allowed",
              });
          }}
        />
        <PermissionSelect<Decision>
          disabled={!trusted()}
          label={t("app_menu.settings_remote_control")}
          options={["ask", "allow", "deny"]}
          value={
            trusted()
              ? (config()?.remoteControl ?? "ask")
              : "deny"
          }
          optionLabel={(decision) =>
            decision === "allow"
              ? t("setting.permissions.allow_permanently")
              : t(`setting.permissions.${decision}`)
          }
          onChange={(decision) => {
            if (trusted())
              setClientConfig(props.clientId, {
                remoteControl:
                  decision === "ask" ? undefined : decision,
              });
          }}
        />
      </SettingGroup>
      <ClientAutomationPermissions
        clientId={props.clientId}
        trusted={trusted()}
      />
    </SettingSection>
  );
}
