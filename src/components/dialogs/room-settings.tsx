import {
  Switch,
  SwitchControl,
  SwitchDescription,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { appState } from "@/libs/state/app-state";
import { resolveRoomConfig } from "@/libs/state/app-options";
import { setRoomConfig } from "@/options";
import { t } from "@/i18n";
import { createUniqueId } from "solid-js";

const megabyte = 1024 * 1024;

export function RoomSettings(props: {
  conversationId: string;
}) {
  const limitId = createUniqueId();
  const config = () =>
    resolveRoomConfig(
      appState.options,
      props.conversationId,
    );
  return (
    <div class="space-y-5">
      <Switch
        class="flex flex-col gap-2"
        checked={config().autoDownloadFiles}
        onChange={(enabled) =>
          setRoomConfig(props.conversationId, {
            autoDownloadFiles: enabled,
          })
        }
      >
        <div class="flex items-center justify-between gap-4">
          <SwitchLabel>
            {t("room_dialog.auto_download.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </div>
        <SwitchDescription class="muted">
          {t("room_dialog.auto_download.description")}
        </SwitchDescription>
      </Switch>
      <div class="flex flex-col gap-2">
        <Label for={limitId}>
          {t("room_dialog.auto_download.limit")}
        </Label>
        <Select<number>
          modal
          disallowEmptySelection
          value={config().autoDownloadMaxSize / megabyte}
          options={[1, 5, 10, 20, 50, 100]}
          disabled={!config().autoDownloadFiles}
          onChange={(size) => {
            if (size !== null)
              setRoomConfig(props.conversationId, {
                autoDownloadMaxSize: size * megabyte,
              });
          }}
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {props.item.rawValue} MB
            </SelectItem>
          )}
        >
          <SelectTrigger
            id={limitId}
            role="combobox"
            aria-label={t(
              "room_dialog.auto_download.limit",
            )}
          >
            <SelectValue<number>>
              {(state) => `${state.selectedOption()} MB`}
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
    </div>
  );
}
