import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setClientConfig } from "@/options";
import { PermissionSelect } from "./permission-select";

export function ClientPermissions(props: {
  clientId: string;
}) {
  type Decision = "ask" | "allow" | "deny";
  const config = () =>
    appState.options.clientConfigs[props.clientId];
  return (
    <div class="setting-group">
      <PermissionSelect<Decision>
        label={t("app_menu.settings_remote_control")}
        options={["ask", "allow", "deny"]}
        value={config()?.remoteControl ?? "ask"}
        optionLabel={(decision) =>
          t(`setting.permissions.${decision}`)
        }
        onChange={(decision) =>
          setClientConfig(props.clientId, {
            remoteControl:
              decision === "ask" ? undefined : decision,
          })
        }
      />
      <PermissionSelect<"allowed" | "disallowed">
        label={t("client.config.provide_file_list.title")}
        description={t(
          "client.config.provide_file_list.description",
        )}
        options={["allowed", "disallowed"]}
        value={
          config()?.provideFileList !== false
            ? "allowed"
            : "disallowed"
        }
        optionLabel={(decision) =>
          t(`setting.permissions.${decision}`)
        }
        onChange={(decision) =>
          setClientConfig(props.clientId, {
            provideFileList: decision === "allowed",
          })
        }
      />
    </div>
  );
}
