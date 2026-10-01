import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setClientConfig } from "@/options";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

export function ClientPermissions(props: {
  clientId: string;
}) {
  type Decision = "ask" | "allow" | "deny";
  const config = () =>
    appState.options.clientConfigs[props.clientId];
  return (
    <div class="space-y-5">
      <div class="flex flex-col gap-2">
        <Label id="client-control-permission">
          {t("app_menu.settings_remote_control")}
        </Label>
        <Select<Decision>
          modal
          disallowEmptySelection
          options={["ask", "allow", "deny"]}
          value={config()?.remoteControl ?? "ask"}
          onChange={(decision) => {
            if (decision)
              setClientConfig(props.clientId, {
                remoteControl:
                  decision === "ask" ? undefined : decision,
              });
          }}
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {t(
                `setting.permissions.${props.item.rawValue}`,
              )}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-labelledby="client-control-permission">
            <SelectValue<Decision>>
              {(state) =>
                t(
                  `setting.permissions.${state.selectedOption()}`,
                )
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div class="space-y-2">
        <Switch
          class="flex items-center justify-between gap-3"
          checked={config()?.provideFileList !== false}
          onChange={(provideFileList) =>
            setClientConfig(props.clientId, {
              provideFileList,
            })
          }
        >
          <SwitchLabel>
            {t("client.config.provide_file_list.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("client.config.provide_file_list.description")}
        </p>
      </div>
    </div>
  );
}
